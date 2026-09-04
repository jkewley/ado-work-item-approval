const path = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = {
    entry: {
        ApprovalControl: "./src/ApprovalControl/ApprovalControl.tsx"
    },
    output: {
        path: path.resolve(__dirname, "dist"),
        filename: "[name]/[name].js",
        // Assets are referenced from dist/<entry>/<entry>.html, so the runtime path has
        // to walk one level up out of the entry folder.
        assetModuleFilename: pathData => {
            const filename = path.basename(pathData.filename || "");
            if (/\.(woff2?|eot|ttf)$/.test(filename)) {
                // tfx only honours a contentType on an individual file entry, not on a
                // directory, so each font has to be named in vss-extension.json. Strip the
                // embedded version (fluent-regular-v1.1.293.woff2) so those entries survive
                // an azure-devops-ui upgrade.
                return "assets/fonts/" + filename.replace(/-v[\d.]+(?=\.[a-z0-9]+$)/, "");
            }
            return "assets/[name][ext]";
        },
        publicPath: "../"
    },
    resolve: {
        extensions: [".ts", ".tsx", ".js"],
        alias: {
            "azure-devops-extension-sdk": path.resolve("node_modules/azure-devops-extension-sdk")
        }
    },
    // azure-devops-ui ships type re-exports webpack cannot see through; harmless.
    ignoreWarnings: [/export .* was not found in/],
    module: {
        rules: [
            { test: /\.tsx?$/, loader: "ts-loader" },
            {
                test: /\.s?css$/,
                use: [
                    "style-loader",
                    "css-loader",
                    {
                        loader: "sass-loader",
                        options: {
                            sassOptions: {
                                // Lets the stylesheets import azure-devops-ui by bare
                                // specifier, so the same SCSS also compiles under the
                                // plain sass API (see scripts/build-preview.js).
                                loadPaths: ["node_modules"],
                                // azure-devops-ui is built on @import, and its .css entry
                                // points can only be pulled in that way, so this cannot
                                // move to @use until the design system does.
                                silenceDeprecations: ["import"]
                            }
                        }
                    }
                ]
            },
            {
                // Emitted as separate cacheable files rather than inlined: the
                // azure-devops-ui icon fonts alone are ~1.7 MB, and this control
                // renders no icons, so they are never actually fetched.
                test: /\.(woff2?|eot|ttf)$/,
                type: "asset/resource"
            },
            {
                test: /\.(svg|png|gif|jpe?g)$/,
                type: "asset/inline"
            }
        ]
    },
    performance: {
        hints: false
    },
    plugins: [
        new CopyWebpackPlugin({
            patterns: [{ from: "**/*.html", context: "src" }]
        })
    ],
    devtool: "source-map"
};
