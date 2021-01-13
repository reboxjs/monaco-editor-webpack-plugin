import * as path from 'path';
import * as webpack from 'webpack';
import * as loaderUtils from 'loader-utils';
import * as fs from 'fs';
import { AddWorkerEntryPointPlugin } from './plugins/AddWorkerEntryPointPlugin';
import { languagesArr, EditorLanguage } from './languages';
import { featuresArr, EditorFeature, NegatedEditorFeature } from './features';
import { IFeatureDefinition } from './types';

const INCLUDE_LOADER_PATH = require.resolve('./loaders/include');

const EDITOR_MODULE: IFeatureDefinition = {
  label: 'editorWorkerService',
  entry: undefined,
  worker: {
    id: 'vs/editor/editor',
    entry: 'vs/editor/editor.worker'
  },
};

const languagesById: { [language: string]: IFeatureDefinition; } = {};
languagesArr.forEach(language => languagesById[language.label] = language);

const featuresById: { [feature: string]: IFeatureDefinition; } = {};
featuresArr.forEach(feature => featuresById[feature.label] = feature);

/**
 * Return a resolved path for a given Monaco file.
 */
function resolveMonacoPath(filePath: string): string {
  try {
    return require.resolve(path.join('@vscode/monaco-editor/esm', filePath));
  } catch(err) {
    try {
      return require.resolve(path.join(process.cwd(), 'node_modules/@vscode/monaco-editor/esm', filePath));
    } catch(err){
      return require.resolve(filePath);
    }
  }
}

/**
 * Return the interpolated final filename for a worker, respecting the file name template.
 */
function getWorkerFilename(filename: string, entry: string): string {
  return loaderUtils.interpolateName(<any>{ resourcePath: entry }, filename, {
    content: fs.readFileSync(resolveMonacoPath(entry))
  });
}

function getFeaturesIds(userFeatures: string[]): string[] {
  function notContainedIn(arr: string[]) {
    return (element: string) => arr.indexOf(element) === -1;
  }

  let featuresIds: string[];

  if (userFeatures.length) {
    const excludedFeatures = userFeatures.filter(f => f[0] === '!').map(f => f.slice(1));
    if (excludedFeatures.length) {
      featuresIds = Object.keys(featuresById).filter(notContainedIn(excludedFeatures))
    } else {
      featuresIds = userFeatures;
    }
  } else {
    featuresIds = Object.keys(featuresById);
  }

  return featuresIds;
}

interface IMonacoEditorWebpackPluginOpts {
  /**
   * Include only a subset of the languages supported.
   */
  languages?: EditorLanguage[];

  /**
   * Custom languages (outside of the ones shipped with the `@vscode/monaco-editor`).
   */
  customLanguages?: IFeatureDefinition[];

  /**
   * Include only a subset of the editor features.
   * Use e.g. '!contextmenu' to exclude a certain feature.
   */
  features?: (EditorFeature | NegatedEditorFeature)[];

  /**
   * Specify a filename template to use for generated files.
   * Use e.g. '[name].worker.[contenthash].js' to include content-based hashes.
   */
  filename?: string;

  /**
   * Override the public path from which files generated by this plugin will be served.
   * This wins out over Webpack's dynamic runtime path and can be useful to avoid attempting to load workers cross-
   * origin when using a CDN for other static resources.
   * Use e.g. '/' if you want to load your resources from the current origin.
   */
  publicPath?: string;
}

interface IInternalMonacoEditorWebpackPluginOpts {
  languages: IFeatureDefinition[];
  features: IFeatureDefinition[];
  filename: string;
  publicPath: string;
}

class MonacoEditorWebpackPlugin implements webpack.WebpackPluginInstance {

  private readonly options: IInternalMonacoEditorWebpackPluginOpts;

  constructor(options: IMonacoEditorWebpackPluginOpts = {}) {
    const languages = options.languages || Object.keys(languagesById);
    const customLanguages = options.customLanguages || [];
    const features = getFeaturesIds(options.features || []);
    this.options = {
      languages: coalesce(languages.map(id => languagesById[id])).concat(customLanguages),
      features: coalesce(features.map(id => featuresById[id])),
      filename: options.filename || "[name].worker.js",
      publicPath: options.publicPath || '',
    };
  }

  apply(compiler: webpack.Compiler): void {
    const { languages, features, filename, publicPath } = this.options;
    const compilationPublicPath = getCompilationPublicPath(compiler);
    const modules = [EDITOR_MODULE].concat(languages).concat(features);
    const workers: ILabeledWorkerDefinition[] = [];
    modules.forEach((module) => {
      if (module.worker) {
        workers.push({
          label: module.label,
          id: module.worker.id,
          entry: module.worker.entry
        });
      }
    });
    const rules = createLoaderRules(languages, features, workers, filename, publicPath, compilationPublicPath);
    const plugins = createPlugins(workers, filename);
    addCompilerRules(compiler, rules);
    addCompilerPlugins(compiler, plugins);
  }
}

interface ILabeledWorkerDefinition {
  label: string;
  id: string;
  entry: string;
}

function addCompilerRules(compiler: webpack.Compiler, rules: webpack.RuleSetRule[]): void {
  const compilerOptions = compiler.options;
  if (!compilerOptions.module) {
    compilerOptions.module = { rules: rules };
  } else {
    const moduleOptions = compilerOptions.module;
    moduleOptions.rules = (moduleOptions.rules || []).concat(rules);
  }
}

function addCompilerPlugins(compiler: webpack.Compiler, plugins: webpack.WebpackPluginInstance[]) {
  plugins.forEach((plugin) => plugin.apply(compiler));
}

function getCompilationPublicPath(compiler: webpack.Compiler): string {
  if (compiler.options.output && compiler.options.output.publicPath) {
    if (typeof compiler.options.output.publicPath === 'string') {
      return compiler.options.output.publicPath;
    } else {
      console.warn(`Cannot handle options.publicPath (expected a string)`);
    }
  }
  return '';
}

function createLoaderRules(languages: IFeatureDefinition[], features: IFeatureDefinition[], workers: ILabeledWorkerDefinition[], filename: string, pluginPublicPath: string, compilationPublicPath: string): webpack.RuleSetRule[] {
  if (!languages.length && !features.length) {
    return [];
  }
  const languagePaths = flatArr(coalesce(languages.map(language => language.entry)));
  const featurePaths = flatArr(coalesce(features.map(feature => feature.entry)));
  const workerPaths = fromPairs(workers.map(({ label, entry }) => [label, getWorkerFilename(filename, entry)]));
  if (workerPaths['typescript']) {
    // javascript shares the same worker
    workerPaths['javascript'] = workerPaths['typescript'];
  }
  if (workerPaths['css']) {
    // scss and less share the same worker
    workerPaths['less'] = workerPaths['css'];
    workerPaths['scss'] = workerPaths['css'];
  }

  if (workerPaths['html']) {
    // handlebars, razor and html share the same worker
    workerPaths['handlebars'] = workerPaths['html'];
    workerPaths['razor'] = workerPaths['html'];
  }

  // Determine the public path from which to load worker JS files. In order of precedence:
  // 1. Plugin-specific public path.
  // 2. Dynamic runtime public path.
  // 3. Compilation public path.
  const pathPrefix = Boolean(pluginPublicPath)
    ? JSON.stringify(pluginPublicPath)
    : `typeof __webpack_public_path__ === 'string' ` +
    `? __webpack_public_path__ ` +
    `: ${JSON.stringify(compilationPublicPath)}`

  const globals = {
    'MonacoEnvironment': `(function (paths) {
      function stripTrailingSlash(str) {
        return str.replace(/\\/$/, '');
      }
      return {
        getWorkerUrl: function (moduleId, label) {
          var pathPrefix = ${pathPrefix};
          var result = (pathPrefix ? stripTrailingSlash(pathPrefix) + '/' : '') + paths[label];
          if (/^((http:)|(https:)|(file:)|(\\/\\/))/.test(result)) {
            var currentUrl = String(window.location);
            var currentOrigin = currentUrl.substr(0, currentUrl.length - window.location.hash.length - window.location.search.length - window.location.pathname.length);
            if (result.substring(0, currentOrigin.length) !== currentOrigin) {
              var js = '/*' + label + '*/importScripts("' + result + '");';
              var blob = new Blob([js], { type: 'application/javascript' });
              return URL.createObjectURL(blob);
            }
          }
          return result;
        }
      };
    })(${JSON.stringify(workerPaths, null, 2)})`,
  };
  return [
    {
      test: /@vscode\/monaco-editor[/\\]esm[/\\]vs[/\\]editor[/\\]editor.(api|main).js/,
      use: [{
        loader: INCLUDE_LOADER_PATH,
        options: {
          globals,
          pre: featurePaths.map((importPath) => resolveMonacoPath(importPath)),
          post: languagePaths.map((importPath) => resolveMonacoPath(importPath)),
        },
      }],
    },
  ];
}

function createPlugins(workers: ILabeledWorkerDefinition[], filename: string): AddWorkerEntryPointPlugin[] {
  return (
    (<AddWorkerEntryPointPlugin[]>[])
      .concat(workers.map(({ id, entry }) =>
        new AddWorkerEntryPointPlugin({
          id,
          entry: resolveMonacoPath(entry),
          filename: getWorkerFilename(filename, entry),
          plugins: [
            new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
          ],
        })
      ))
  );
}

function flatArr<T>(items: (T | T[])[]): T[] {
  return items.reduce((acc: T[], item: T | T[]) => {
    if (Array.isArray(item)) {
      return (<T[]>[]).concat(acc).concat(item);
    }
    return (<T[]>[]).concat(acc).concat([item]);
  }, <T[]>[]);
}

function fromPairs<T>(values: [string, T][]): { [key: string]: T; } {
  return values.reduce((acc, [key, value]) => Object.assign(acc, { [key]: value }), <{ [key: string]: T; }>{});
}

function coalesce<T>(array: ReadonlyArray<T | undefined | null>): T[] {
  return <T[]>array.filter(Boolean);
}

export = MonacoEditorWebpackPlugin;
