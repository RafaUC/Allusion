// Common webpack configuration shared between dev and production builds
// Webpack is used to bundle our source code, optimizing which scripts are loaded
// and ensuring all required files are neatly organized in the build directory.

const HtmlWebpackPlugin = require('html-webpack-plugin');
const path = require('path');

const mainConfig = {
  entry: './src/main.ts',
  target: ['electron-main', 'es2022'],
  output: {
    filename: 'main.bundle.js',
    path: path.resolve(__dirname, 'build'),
    clean: true,
    // Keep filename ending the same: certain filename patterns required for certain Electron icon uses
    assetModuleFilename: 'assets/[hash]_[name][ext][query]',
  },
  resolve: {
    extensions: ['.js', '.json', '.ts'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: false,
          },
        },
      },
      {
        test: /\.(jpg|png|gif|ico|icns|eot|ttf|woff|woff2)$/,
        type: 'asset/resource',
      },
    ],
  },
  externals: {
    fsevents: "require('fsevents')",
    '@parcel/watcher': "require('@parcel/watcher')",
  },
  // Modern webpack 5 cache configuration
  cache: {
    type: 'filesystem',
    buildDependencies: {
      config: [__filename],
    },
  },
};

const rendererConfig = {
  entry: './src/renderer.tsx',
  target: ['electron-renderer', 'es2022'],
  output: {
    filename: 'renderer.bundle.js',
    path: path.resolve(__dirname, 'build'),
  },
  experiments: {
    asyncWebAssembly: true,
  },
  resolve: {
    extensions: ['.js', '.json', '.ts', '.tsx', '.svg', '.wasm'],
    alias: {
      common: path.resolve(__dirname, 'common/'),
      widgets: path.resolve(__dirname, 'widgets/'),
      resources: path.resolve(__dirname, 'resources/'),
      src: path.resolve(__dirname, 'src/'),
      wasm: path.resolve(__dirname, 'wasm/'),
    },
  },
  module: {
    rules: [
      {
        test: /\.(ts|tsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: false,
          },
        },
      },
      {
        test: /\.(jpg|png|gif|ico|icns|eot|ttf|woff|woff2)$/,
        type: 'asset/resource',
      },
      {
        test: /\.wasm$/,
        type: 'asset/resource',
      },
      {
        test: /\.js$/,
        resourceQuery: /file/,
        type: 'asset/resource',
      },
      {
        test: /\.svg$/,
        oneOf: [
          {
            issuer: /\.scss$/,
            type: 'asset/resource',
          },
          {
            issuer: /\.tsx?$/,
            use: ['@svgr/webpack'],
          },
        ],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, './src/index.html'),
    }),
  ],
  externals: {
    fsevents: "require('fsevents')",
    '@parcel/watcher': "require('@parcel/watcher')",
  },
  // Modern webpack 5 cache configuration
  cache: {
    type: 'filesystem',
    buildDependencies: {
      config: [__filename],
    },
  },
};

module.exports = { mainConfig, rendererConfig };
