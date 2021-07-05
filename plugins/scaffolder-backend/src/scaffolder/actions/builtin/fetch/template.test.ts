/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import os from 'os';
import fs from 'fs-extra';
import mockFs from 'mock-fs';
import { getVoidLogger, UrlReader } from '@backstage/backend-common';
import { ScmIntegrations } from '@backstage/integration';
import { PassThrough } from 'stream';
import { fetchContents } from './helpers';
import { ActionContext, TemplateAction } from '../../types';
import { createFetchTemplateAction, FetchTemplateInput } from './template';

jest.mock('./helpers', () => ({
  fetchContents: jest.fn(),
}));

const mockFetchContents = fetchContents as jest.MockedFunction<
  typeof fetchContents
>;

describe('fetch:template', () => {
  let action: TemplateAction<any>;

  const workspacePath = os.tmpdir();
  const createTemporaryDirectory: jest.MockedFunction<
    ActionContext<FetchTemplateInput>['createTemporaryDirectory']
  > = jest.fn(() =>
    Promise.resolve(
      `${workspacePath}/${createTemporaryDirectory.mock.calls.length}`,
    ),
  );

  const logger = getVoidLogger();

  const mockContext = (inputPatch: Partial<FetchTemplateInput> = {}) => ({
    baseUrl: 'base-url',
    input: {
      url: './skeleton',
      targetPath: './target',
      values: {
        test: 'value',
      },
      ...inputPatch,
    },
    output: jest.fn(),
    logStream: new PassThrough(),
    logger,
    workspacePath,
    createTemporaryDirectory,
  });

  beforeEach(() => {
    mockFs();

    action = createFetchTemplateAction({
      reader: (Symbol('UrlReader') as unknown) as UrlReader,
      integrations: (Symbol('Integrations') as unknown) as ScmIntegrations,
    });
  });

  afterEach(() => {
    mockFs.restore();
  });

  it(`returns a TemplateAction with the id 'fetch:template'`, () => {
    expect(action.id).toEqual('fetch:template');
  });

  describe('handler', () => {
    it('throws if output directory is outside the workspace', async () => {
      await expect(() =>
        action.handler(mockContext({ targetPath: '../' })),
      ).rejects.toThrowError(/outside the working directory/i);
    });

    it('throws if copyWithoutRender parameter is not an array', async () => {
      await expect(() =>
        action.handler(
          mockContext({ copyWithoutRender: ('abc' as unknown) as string[] }),
        ),
      ).rejects.toThrowError(/copyWithoutRender must be an array/i);
    });

    describe('with valid input', () => {
      let context: ActionContext<FetchTemplateInput>;

      beforeEach(async () => {
        context = mockContext({
          values: {
            name: 'test-project',
            count: 1234,
            itemList: ['first', 'second', 'third'],
          },
        });

        mockFetchContents.mockImplementation(({ outputPath }) => {
          mockFs({
            [outputPath]: {
              'empty-dir-${{ count }}': {},
              'static.txt': 'static content',
              '${{ name }}.txt': 'static content',
              subdir: {
                'templated-content.txt': '${{ name }}: ${{ count }}',
              },
              '.${{ name }}': '${{ itemList | dump }}',
            },
          });

          return Promise.resolve();
        });

        await action.handler(context);
      });

      it('uses fetchContents to retrieve the template content', () => {
        expect(mockFetchContents).toHaveBeenCalledWith(
          expect.objectContaining({
            baseUrl: context.baseUrl,
            fetchUrl: context.input.url,
          }),
        );
      });

      it('copies files with no templating in names or content successfully', async () => {
        await expect(
          fs.readFile(`${workspacePath}/target/static.txt`, 'utf-8'),
        ).resolves.toEqual('static content');
      });

      it('copies files with templated names successfully', async () => {
        await expect(
          fs.readFile(`${workspacePath}/target/test-project.txt`, 'utf-8'),
        ).resolves.toEqual('static content');
      });

      it('copies files with templated content successfully', async () => {
        await expect(
          fs.readFile(
            `${workspacePath}/target/subdir/templated-content.txt`,
            'utf-8',
          ),
        ).resolves.toEqual('test-project: 1234');
      });

      it('processes dotfiles', async () => {
        await expect(
          fs.readFile(`${workspacePath}/target/.test-project`, 'utf-8'),
        ).resolves.toEqual('["first","second","third"]');
      });

      it('copies empty directories', async () => {
        await expect(
          fs.readdir(`${workspacePath}/target/empty-dir-1234`, 'utf-8'),
        ).resolves.toEqual([]);
      });
    });

    describe('copyWithoutRender', () => {
      let context: ActionContext<FetchTemplateInput>;

      beforeEach(async () => {
        context = mockContext({
          values: {
            name: 'test-project',
            count: 1234,
          },
          copyWithoutRender: ['.unprocessed'],
        });

        mockFetchContents.mockImplementation(({ outputPath }) => {
          mockFs({
            [outputPath]: {
              processed: {
                'templated-content-${{ name }}.txt': '${{ count }}',
              },
              '.unprocessed': {
                'templated-content-${{ name }}.txt': '${{ count }}',
              },
            },
          });

          return Promise.resolve();
        });

        await action.handler(context);
      });

      it('ignores template syntax in files matched in copyWithoutRender', async () => {
        await expect(
          fs.readFile(
            `${workspacePath}/target/.unprocessed/templated-content-\${{ name }}.txt`,
            'utf-8',
          ),
        ).resolves.toEqual('${{ count }}');
      });

      it('processes files not matched in copyWithoutRender', async () => {
        await expect(
          fs.readFile(
            `${workspacePath}/target/processed/templated-content-test-project.txt`,
            'utf-8',
          ),
        ).resolves.toEqual('1234');
      });
    });
  });
});
