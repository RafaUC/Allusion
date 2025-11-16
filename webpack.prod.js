// Production configuration for Webpack.
// This extends the common configuration with production-specific optimizations.

const { merge } = require('webpack-merge');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const { mainConfig, rendererConfig } = require('./webpack.common.js');

const prodMainConfig = merge(mainConfig, {
  mode: 'production',
  devtool: false,
  optimization: {
    minimize: true,
    moduleIds: 'deterministic',
    nodeEnv: 'production',
  },
  performance: {
    hints: 'warning',
    maxEntrypointSize: 512000,
    maxAssetSize: 512000,
  },
});

const prodRendererConfig = merge(rendererConfig, {
  mode: 'production',
  devtool: false,
  module: {
    rules: [
      {
        test: /\.(scss|css)$/,
        use: [
          {
            loader: MiniCssExtractPlugin.loader,
            options: {
              publicPath: './',
            },
          },
          'css-loader',
          'sass-loader',
        ],
      },
      {
        test: /\.node$/,
        type: 'asset/resource',
        generator: {
          filename: 'native/[name][ext]',
        },
      },
    ],
  },
  plugins: [
    new MiniCssExtractPlugin({
      filename: '[name].[contenthash].css',
      chunkFilename: '[id].[contenthash].css',
    }),
  ],
  optimization: {
    minimize: true,
    moduleIds: 'deterministic',
    nodeEnv: 'production',
  },
  performance: {
    hints: 'warning',
    maxEntrypointSize: 1024000,
    maxAssetSize: 1024000,
  },
});

module.exports = [prodMainConfig, prodRendererConfig];
