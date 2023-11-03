"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPostTreeShakeTransformSerializerPlugin = exports.isShakingEnabled = exports.treeShakeSerializerPlugin = void 0;
/**
 * Copyright © 2023 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
const core_1 = require("@babel/core");
const babylon = __importStar(require("@babel/parser"));
const countLines_1 = __importDefault(require("metro/src/lib/countLines"));
const metro_source_map_1 = require("metro-source-map");
const sideEffectsSerializerPlugin_1 = require("./sideEffectsSerializerPlugin");
const JsFileWrapping = require('metro/src/ModuleGraph/worker/JsFileWrapping');
const collectDependencies = require('metro/src/ModuleGraph/worker/collectDependencies');
const generateImportNames = require('metro/src/ModuleGraph/worker/generateImportNames');
const inspect = (...props) => console.log(...props.map((prop) => require('util').inspect(prop, { depth: 20, colors: true })));
// Collect a list of exports that are not used within the module.
function findUnusedExports(ast) {
    const exportedIdentifiers = new Set();
    const usedIdentifiers = new Set();
    const unusedExports = [];
    // First pass: collect all export identifiers
    (0, core_1.traverse)(ast, {
        ExportNamedDeclaration(path) {
            const { declaration, specifiers } = path.node;
            if (declaration) {
                if (declaration.declarations) {
                    declaration.declarations.forEach((decl) => {
                        exportedIdentifiers.add(decl.id.name);
                    });
                }
                else {
                    exportedIdentifiers.add(declaration.id.name);
                }
            }
            specifiers.forEach((spec) => {
                exportedIdentifiers.add(spec.exported.name);
            });
        },
        ExportDefaultDeclaration(path) {
            // Default exports need to be handled separately
            // Assuming the default export is a function or class declaration:
            if (path.node.declaration.id) {
                exportedIdentifiers.add(path.node.declaration.id.name);
            }
        },
    });
    // Second pass: find all used identifiers
    (0, core_1.traverse)(ast, {
        Identifier(path) {
            if (path.isReferencedIdentifier()) {
                usedIdentifiers.add(path.node.name);
            }
        },
    });
    // Determine which exports are unused
    exportedIdentifiers.forEach((exported) => {
        if (!usedIdentifiers.has(exported)) {
            unusedExports.push(exported);
        }
    });
    return unusedExports;
}
const annotate = false;
function treeShakeSerializerPlugin(config) {
    return async function treeShakeSerializer(entryPoint, preModules, graph, options) {
        // console.log('treeshake:', graph.transformOptions);
        if (!isShakingEnabled(graph, options)) {
            return [entryPoint, preModules, graph, options];
        }
        function collectImportExports(value) {
            function getGraphId(moduleId) {
                const key = [...value.dependencies.values()].find((dep) => {
                    return dep.data.name === moduleId;
                })?.absolutePath;
                if (!key) {
                    throw new Error(`Failed to find graph key for import "${moduleId}" in module "${value.path}". Options: ${[...value.dependencies.values()].map((v) => v.data.name)}`);
                }
                return key;
            }
            for (const index in value.output) {
                const outputItem = value.output[index];
                const ast = outputItem.data.ast ?? babylon.parse(outputItem.data.code, { sourceType: 'unambiguous' });
                outputItem.data.ast = ast;
                outputItem.data.modules = {
                    imports: [],
                    exports: [],
                };
                (0, core_1.traverse)(ast, {
                    // Traverse and collect import/export statements.
                    ImportDeclaration(path) {
                        const source = path.node.source.value;
                        const specifiers = path.node.specifiers.map((specifier) => {
                            return {
                                type: specifier.type,
                                importedName: specifier.type === 'ImportSpecifier' ? specifier.imported.name : null,
                                localName: specifier.local.name,
                            };
                        });
                        outputItem.data.modules.imports.push({
                            source,
                            key: getGraphId(source),
                            specifiers,
                        });
                    },
                    // Track require calls
                    CallExpression(path) {
                        if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'require') {
                            const arg = path.node.arguments[0];
                            if (arg.type === 'StringLiteral') {
                                outputItem.data.modules.imports.push({
                                    source: arg.value,
                                    key: getGraphId(arg.value),
                                    specifiers: [],
                                    cjs: true,
                                });
                            }
                        }
                    },
                    // export from
                    ExportNamedDeclaration(path) {
                        if (path.node.source) {
                            const source = path.node.source.value;
                            const specifiers = path.node.specifiers.map((specifier) => {
                                return {
                                    type: specifier.type,
                                    exportedName: specifier.exported.name,
                                    localName: specifier.local.name,
                                };
                            });
                            outputItem.data.modules.imports.push({
                                source,
                                key: getGraphId(source),
                                specifiers,
                            });
                        }
                    },
                    // export * from
                    ExportAllDeclaration(path) {
                        if (path.node.source) {
                            const source = path.node.source.value;
                            outputItem.data.modules.imports.push({
                                source,
                                key: getGraphId(source),
                                specifiers: [],
                                star: true,
                            });
                        }
                    },
                });
                // inspect('imports', outputItem.data.modules.imports);
            }
        }
        // const detectCommonJsExportsUsage = (ast: Parameters<typeof traverse>[0]): boolean => {
        //   let usesCommonJsExports = false;
        //   traverse(ast, {
        //     MemberExpression(path) {
        //       if (
        //         (path.node.object.name === 'module' && path.node.property.name === 'exports') ||
        //         path.node.object.name === 'exports'
        //       ) {
        //         usesCommonJsExports = true;
        //         console.log(`Found usage of ${path.node.object.name}.${path.node.property.name}`);
        //       }
        //     },
        //     CallExpression(path) {
        //       // Check for Object.assign or Object.defineProperties
        //       if (
        //         path.node.callee.type === 'MemberExpression' &&
        //         path.node.callee.object.name === 'Object' &&
        //         (path.node.callee.property.name === 'assign' ||
        //           path.node.callee.property.name === 'defineProperties')
        //       ) {
        //         // Check if the first argument is module.exports
        //         const firstArg = path.node.arguments[0];
        //         if (
        //           firstArg.type === 'MemberExpression' &&
        //           firstArg.object.name === 'module' &&
        //           firstArg.property.name === 'exports'
        //         ) {
        //           usesCommonJsExports = true;
        //         } else if (firstArg.type === 'Identifier' && firstArg.name === 'exports') {
        //           usesCommonJsExports = true;
        //         }
        //       }
        //     },
        //   });
        //   return usesCommonJsExports;
        // };
        function treeShakeExports(depId, value) {
            const inverseDeps = [...value.inverseDependencies.values()].map((id) => {
                return graph.dependencies.get(id);
            });
            const isExportUsed = (importName) => {
                return inverseDeps.some((dep) => {
                    return dep?.output.some((outputItem) => {
                        if (outputItem.type === 'js/module') {
                            const imports = outputItem.data.modules?.imports;
                            if (imports) {
                                return imports.some((importItem) => {
                                    if (importItem.key !== depId) {
                                        return false;
                                    }
                                    // If the import is CommonJS, then we can't tree-shake it.
                                    if (importItem.cjs || importItem.star) {
                                        return true;
                                    }
                                    return importItem.specifiers.some((specifier) => {
                                        if (specifier.type === 'ImportDefaultSpecifier') {
                                            return importName === 'default';
                                        }
                                        // Star imports are always used.
                                        if (specifier.type === 'ImportNamespaceSpecifier') {
                                            return true;
                                        }
                                        // `export { default as add } from './add'`
                                        if (specifier.type === 'ExportSpecifier') {
                                            return specifier.localName === importName;
                                        }
                                        return (specifier.importedName === importName || specifier.exportedName === importName);
                                    });
                                });
                            }
                        }
                        return false;
                    });
                });
            };
            for (const index in value.output) {
                const outputItem = value.output[index];
                const ast = outputItem.data.ast;
                function markUnused(path, node) {
                    if (annotate) {
                        node.leadingComments = node.leadingComments ?? [];
                        if (!node.leadingComments.some((comment) => comment.value.includes('unused export'))) {
                            node.leadingComments.push({
                                type: 'CommentBlock',
                                value: ` unused export ${node.id.name} `,
                            });
                        }
                    }
                    else {
                        path.remove();
                    }
                }
                // Collect a list of exports that are not used within the module.
                const unusedExports = findUnusedExports(ast);
                // Traverse exports and mark them as used or unused based on if inverse dependencies are importing them.
                (0, core_1.traverse)(ast, {
                    ExportDefaultDeclaration(path) {
                        if (unusedExports.includes('default') && !isExportUsed('default')) {
                            markUnused(path, path.node);
                        }
                    },
                    ExportNamedDeclaration(path) {
                        const declaration = path.node.declaration;
                        if (declaration) {
                            if (declaration.type === 'VariableDeclaration') {
                                declaration.declarations.forEach((decl) => {
                                    if (decl.id.type === 'Identifier') {
                                        if (unusedExports.includes(decl.id.name) && !isExportUsed(decl.id.name)) {
                                            markUnused(path, decl);
                                        }
                                    }
                                });
                            }
                            else {
                                // console.log(
                                //   'check:',
                                //   declaration.type,
                                //   declaration.id?.name,
                                //   isExportUsed(declaration.id.name),
                                //   unusedExports
                                // );
                                // if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration')
                                if (unusedExports.includes(declaration.id.name) &&
                                    !isExportUsed(declaration.id.name)) {
                                    markUnused(path, declaration);
                                }
                            }
                        }
                    },
                });
            }
        }
        function removeUnusedImports(value, ast) {
            // Traverse imports and remove unused imports.
            // Keep track of all the imported identifiers
            const importedIdentifiers = new Set();
            // Keep track of all used identifiers
            const usedIdentifiers = new Set();
            (0, core_1.traverse)(ast, {
                ImportSpecifier(path) {
                    importedIdentifiers.add(
                    // Support `import { foo as bar } from './foo'`
                    path.node.local.name ??
                        // Support `import { foo } from './foo'`
                        path.node.imported.name);
                },
                ImportDefaultSpecifier(path) {
                    importedIdentifiers.add(path.node.local.name);
                },
                ImportNamespaceSpecifier(path) {
                    importedIdentifiers.add(path.node.local.name);
                },
                Identifier(path) {
                    // Make sure this identifier isn't coming from an import specifier
                    if (path.findParent((path) => path.isImportSpecifier())) {
                        return;
                    }
                    if (!path.scope.bindingIdentifierEquals(path.node.name, path.node)) {
                        usedIdentifiers.add(path.node.name);
                    }
                },
            });
            // Determine unused identifiers by subtracting the used from the imported
            const unusedImports = [...importedIdentifiers].filter((identifier) => !usedIdentifiers.has(identifier));
            // inspect(ast);
            let removed = false; //unusedImports.length > 0;
            // Remove the unused imports from the AST
            (0, core_1.traverse)(ast, {
                ImportDeclaration(path) {
                    const originalSize = path.node.specifiers.length;
                    path.node.specifiers = path.node.specifiers.filter((specifier) => {
                        if (specifier.type === 'ImportDefaultSpecifier') {
                            return !unusedImports.includes(specifier.local.name);
                        }
                        else if (specifier.type === 'ImportNamespaceSpecifier') {
                            return !unusedImports.includes(specifier.local.name);
                        }
                        else {
                            return !unusedImports.includes(specifier.imported.name);
                        }
                        // if (!specifier.imported) {
                        // }
                        // return !unusedImports.includes(specifier.imported.name);
                    });
                    if (originalSize !== path.node.specifiers.length) {
                        removed = true;
                    }
                    // If no specifiers are left after filtering, remove the whole import declaration
                    // e.g. `import './unused'` or `import {} from './unused'` -> remove.
                    if (path.node.specifiers.length === 0) {
                        // TODO: Ensure the module isn't side-effect-ful or importing a module that is side-effect-ful.
                        const importModuleId = path.node.source.value;
                        // Unlink the module in the graph
                        const depId = [...value.dependencies.entries()].find(([key, dep]) => {
                            return dep.data.name === importModuleId;
                        })?.[0];
                        // // Should never happen but we're playing with fire here.
                        // if (!depId) {
                        //   throw new Error(
                        //     `Failed to find graph key for import "${importModuleId}" from "${importModuleId}" while optimizing ${
                        //       value.path
                        //     }. Options: ${[...value.dependencies.values()].map((v) => v.data.name)}`
                        //   );
                        // }
                        // If the dependency was already removed, then we don't need to do anything.
                        if (depId) {
                            const dep = value.dependencies.get(depId);
                            const graphDep = graph.dependencies.get(dep.absolutePath);
                            // Should never happen but we're playing with fire here.
                            if (!graphDep) {
                                throw new Error(`Failed to find graph key for import "${importModuleId}" while optimizing ${value.path}. Options: ${[...value.dependencies.values()].map((v) => v.data.name)}`);
                            }
                            // inspect(
                            //   'remove',
                            //   depId,
                            //   dep.absolutePath,
                            //   hasSideEffect(graphDep),
                            //   isEmptyModule(graphDep)
                            // );
                            if (
                            // Don't remove the module if it has side effects.
                            !(0, sideEffectsSerializerPlugin_1.hasSideEffect)(graph, graphDep) ||
                                // Unless it's an empty module.
                                isEmptyModule(graphDep)) {
                                // Remove inverse link to this dependency
                                graphDep.inverseDependencies.delete(value.path);
                                if (graphDep.inverseDependencies.size === 0) {
                                    // Remove the dependency from the graph as no other modules are using it anymore.
                                    graph.dependencies.delete(dep.absolutePath);
                                }
                                // Remove a random instance of the dep count to track if there are multiple imports.
                                dep.data.data.locs.pop();
                                if (!dep.data.data.locs.length) {
                                    // Remove dependency from this module in the graph
                                    value.dependencies.delete(depId);
                                }
                                // Delete the AST
                                path.remove();
                                // Mark the module as removed so we know to traverse again.
                                removed = true;
                            }
                        }
                        else {
                            // TODO: I'm not sure what to do here?
                            // Delete the AST
                            // path.remove();
                            // // Mark the module as removed so we know to traverse again.
                            // removed = true;
                        }
                    }
                },
            });
            return removed;
        }
        function isEmptyModule(value) {
            function isASTEmptyOrContainsOnlyCommentsAndUseStrict(ast) {
                if (!ast?.program.body.length) {
                    return true;
                }
                let isEmptyOrCommentsAndUseStrict = true; // Assume true until proven otherwise
                (0, core_1.traverse)(ast, {
                    enter(path) {
                        const { node } = path;
                        // If it's not a Directive, ExpressionStatement, or empty body,
                        // it means we have actual code
                        if (node.type !== 'Directive' &&
                            node.type !== 'ExpressionStatement' &&
                            !(node.type === 'Program' && node.body.length === 0)) {
                            isEmptyOrCommentsAndUseStrict = false;
                            path.stop(); // No need to traverse further
                            return;
                        }
                        // If it's an ExpressionStatement, check if it is "use strict"
                        if (node.type === 'ExpressionStatement' && node.expression) {
                            // Check if it's a Literal with value "use strict"
                            const expression = node.expression;
                            if (expression.type !== 'Literal' || expression.value !== 'use strict') {
                                isEmptyOrCommentsAndUseStrict = false;
                                path.stop(); // No need to traverse further
                            }
                        }
                    },
                    // If we encounter any non-comment nodes, it's not empty
                    noScope: true,
                });
                return isEmptyOrCommentsAndUseStrict;
            }
            return value.output.every((outputItem) => {
                return isASTEmptyOrContainsOnlyCommentsAndUseStrict(accessAst(outputItem));
            });
        }
        function treeShakeAll(depth = 0) {
            if (depth > 10) {
                return;
            }
            // This pass will parse all modules back to AST and include the import/export statements.
            for (const value of graph.dependencies.values()) {
                collectImportExports(value);
            }
            // This pass will annotate the AST with the used and unused exports.
            for (const [depId, value] of graph.dependencies.entries()) {
                treeShakeExports(depId, value);
                value.output.forEach((outputItem) => {
                    const ast = accessAst(outputItem);
                    if (removeUnusedImports(value, ast)) {
                        // TODO: haha this is slow
                        treeShakeAll(depth + 1);
                    }
                });
            }
        }
        // Tree shake the graph.
        treeShakeAll();
        return [entryPoint, preModules, graph, options];
    };
}
exports.treeShakeSerializerPlugin = treeShakeSerializerPlugin;
function accessAst(output) {
    // @ts-expect-error
    return output.data.ast;
}
function isShakingEnabled(graph, options) {
    return graph.transformOptions.customTransformOptions?.treeshake === 'true' && !options.dev;
}
exports.isShakingEnabled = isShakingEnabled;
function createPostTreeShakeTransformSerializerPlugin(config) {
    return async function treeShakeSerializer(entryPoint, preModules, graph, options) {
        // console.log('treeshake:', graph.transformOptions);
        if (!isShakingEnabled(graph, options)) {
            return [entryPoint, preModules, graph, options];
        }
        const includeDebugInfo = false;
        const preserveEsm = false;
        // TODO: When we can reuse transformJS for JSON, we should not derive `minify` separately.
        const minify = graph.transformOptions.minify &&
            graph.transformOptions.unstable_transformProfile !== 'hermes-canary' &&
            graph.transformOptions.unstable_transformProfile !== 'hermes-stable';
        // Convert all remaining AST and dependencies to standard output that Metro expects.
        // This is normally done in the transformer, but we skipped it so we could perform graph analysis (tree-shake).
        for (const value of graph.dependencies.values()) {
            for (const index in value.output) {
                const outputItem = value.output[index];
                let ast = accessAst(outputItem);
                if (!ast) {
                    continue;
                }
                delete outputItem.data.ast;
                const { importDefault, importAll } = generateImportNames(ast);
                const babelPluginOpts = {
                    // ...options,
                    inlineableCalls: [importDefault, importAll],
                    importDefault,
                    importAll,
                };
                ast = (0, core_1.transformFromAstSync)(ast, undefined, {
                    ast: true,
                    babelrc: false,
                    code: false,
                    configFile: false,
                    comments: includeDebugInfo,
                    compact: false,
                    filename: value.path,
                    plugins: [
                        metro_source_map_1.functionMapBabelPlugin,
                        !preserveEsm && [
                            require('metro-transform-plugins/src/import-export-plugin'),
                            babelPluginOpts,
                        ],
                        !preserveEsm && [require('metro-transform-plugins/src/inline-plugin'), babelPluginOpts],
                    ].filter(Boolean),
                    sourceMaps: false,
                    // Not-Cloning the input AST here should be safe because other code paths above this call
                    // are mutating the AST as well and no code is depending on the original AST.
                    // However, switching the flag to false caused issues with ES Modules if `experimentalImportSupport` isn't used https://github.com/facebook/metro/issues/641
                    // either because one of the plugins is doing something funky or Babel messes up some caches.
                    // Make sure to test the above mentioned case before flipping the flag back to false.
                    cloneInputAst: true,
                })?.ast;
                let dependencyMapName = '';
                // This pass converts the modules to use the generated import names.
                try {
                    const opts = {
                        asyncRequireModulePath: config.transformer?.asyncRequireModulePath ??
                            require.resolve('metro-runtime/src/modules/asyncRequire'),
                        dependencyTransformer: undefined,
                        dynamicRequires: getDynamicDepsBehavior(config.transformer?.dynamicDepsInPackages ?? 'reject', value.path),
                        inlineableCalls: [importDefault, importAll],
                        keepRequireNames: options.dev,
                        allowOptionalDependencies: config.transformer?.allowOptionalDependencies ?? true,
                        dependencyMapName: config.transformer?.unstable_dependencyMapReservedName,
                        unstable_allowRequireContext: config.transformer?.unstable_allowRequireContext,
                    };
                    ({ ast, dependencyMapName } = collectDependencies(ast, opts));
                    // ({ ast, dependencies, dependencyMapName } = collectDependencies(ast, opts));
                }
                catch (error) {
                    // if (error instanceof InternalInvalidRequireCallError) {
                    //   throw new InvalidRequireCallError(error, file.filename);
                    // }
                    throw error;
                }
                const globalPrefix = '';
                const { ast: wrappedAst } = JsFileWrapping.wrapModule(ast, importDefault, importAll, dependencyMapName, globalPrefix);
                const outputCode = (0, core_1.transformFromAstSync)(wrappedAst, undefined, {
                    ast: false,
                    babelrc: false,
                    code: true,
                    configFile: false,
                    // comments: true,
                    // compact: false,
                    comments: includeDebugInfo,
                    compact: !includeDebugInfo,
                    filename: value.path,
                    plugins: [],
                    sourceMaps: false,
                    // Not-Cloning the input AST here should be safe because other code paths above this call
                    // are mutating the AST as well and no code is depending on the original AST.
                    // However, switching the flag to false caused issues with ES Modules if `experimentalImportSupport` isn't used https://github.com/facebook/metro/issues/641
                    // either because one of the plugins is doing something funky or Babel messes up some caches.
                    // Make sure to test the above mentioned case before flipping the flag back to false.
                    cloneInputAst: true,
                }).code;
                let map = [];
                let code = outputCode;
                if (minify && !preserveEsm) {
                    const minifyCode = require('metro-minify-terser');
                    try {
                        ({ map, code } = await minifyCode({
                            //           code: string;
                            // map?: BasicSourceMap;
                            // filename: string;
                            // reserved: ReadonlyArray<string>;
                            // config: MinifierConfig;
                            // projectRoot,
                            filename: value.path,
                            code,
                            // file.code,
                            // map,
                            config: {},
                            reserved: [],
                            // config,
                        }));
                    }
                    catch (error) {
                        console.error('Error minifying: ' + value.path);
                        console.error(code);
                        throw error;
                    }
                }
                outputItem.data.code = (includeDebugInfo ? `\n// ${value.path}\n` : '') + code;
                // @ts-expect-error
                outputItem.data.lineCount = (0, countLines_1.default)(outputItem.data.code);
                // @ts-expect-error
                outputItem.data.map = map;
                // @ts-expect-error
                outputItem.data.functionMap =
                    ast.metadata?.metro?.functionMap ??
                        // Fallback to deprecated explicitly-generated `functionMap`
                        ast.functionMap ??
                        null;
                // TODO: minify the code to fold anything that was dropped above.
                // console.log('output code', outputItem.data.code);
            }
        }
        return [entryPoint, preModules, graph, options];
    };
}
exports.createPostTreeShakeTransformSerializerPlugin = createPostTreeShakeTransformSerializerPlugin;
function getDynamicDepsBehavior(inPackages, filename) {
    switch (inPackages) {
        case 'reject':
            return 'reject';
        case 'throwAtRuntime':
            const isPackage = /(?:^|[/\\])node_modules[/\\]/.test(filename);
            return isPackage ? inPackages : 'reject';
        default:
            throw new Error(`invalid value for dynamic deps behavior: \`${inPackages}\``);
    }
}
// TODO: Up-transform CJS to ESM
// https://github.com/vite-plugin/vite-plugin-commonjs/tree/main#cases
//
// const foo = require('foo').default
// ↓ ↓ ↓
// import foo from 'foo'
//
// const foo = require('foo')
// ↓ ↓ ↓
// import * as foo from 'foo'
//
// module.exports = { foo: 'bar' }
// ↓ ↓ ↓
// export const foo = 'bar'
//
// module.exports = { get foo() { return require('./foo') } }
// ↓ ↓ ↓
// export * as foo from './foo'
//
// Move requires out of conditionals if they don't contain side effects.
// TODO: Barrel reduction
//
// import { View, Image } from 'react-native';
// ↓ ↓ ↓
// import View from 'react-native/Libraries/Components/View/View';
// import Image from 'react-native/Libraries/Components/Image/Image';
//
// 1. For each import, recursively check if the module comes from a re-export.
// 2. Ensure each file in the re-export chain is not side-effect-ful.
// 3. Collapse the re-export chain into a single import.
// Check if "is re-export"
// 1. `export { default } from './foo'`
// 2. `export * from './foo'`
// 3. `export { default as foo } from './foo'`
// 4. `export { foo } from './foo'`
//
// Simplify:
// - Convert static cjs usage to esm.
// - Reduce `import { foo } from './foo'; export { foo }` to `export { foo } from './foo'`
// Test case: react native barrel reduction
// import warnOnce from './Libraries/Utilities/warnOnce';
// module.exports = {
//   get alpha() {
//     return require('./alpha')
//       .default;
//   },
//   get beta() {
//     return require('./beta').Beta;
//   },
//   get omega() {
//     return require('./omega');
//   },
//   get gamma() {
//     warnOnce(
//       'progress-bar-android-moved',
//       'ProgressBarAndroid has been extracted from react-native core and will be removed in a future release. ' +
//         "It can now be installed and imported from '@react-native-community/progress-bar-android' instead of 'react-native'. " +
//         'See https://github.com/react-native-progress-view/progress-bar-android',
//     );
//     return require('./gamma');
//   },
//   get delta() {
//     return () => console.warn('this is gone');
//   },
//   get zeta() {
//     console.error('do not use this');
//     return require('zeta').zeta;
//   },
// };
