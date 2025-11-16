// Development configuration for Webpack.
// This extends the common configuration with development-specific settings.

const { merge } = require('webpack-merge');
const { mainConfig, rendererConfig } = require('./webpack.common.js');

const devMainConfig = merge(mainConfig, {
  mode: 'development',
  devtool: 'source-map',
  stats: {
    errorDetails: true,
  },
});

const devRendererConfig = merge(rendererConfig, {
  mode: 'development',
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.(scss|css)$/,
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: {
              sourceMap: true,
            }
          },
          {
            loader: 'sass-loader',
            options: {
              sourceMap: true,
            }
          },
        ],
      },
    ],
  },
  stats: {
    errorDetails: true,
  },
  // Performance hints disabled in development
  performance: {
    hints: false,
  },
});

module.exports = [devMainConfig, devRendererConfig];
