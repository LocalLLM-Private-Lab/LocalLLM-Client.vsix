//@ts-check
'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }],
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: { level: 'log' },
};

// Webview frontend bundle (runs in browser context, not Node)
const webviewConfig = {
  target: 'web',
  mode: 'none',
  entry: './src/ui/webview/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'webview.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader', options: { configFile: 'tsconfig.webview.json' } }],
      },
      {
        // KaTeX CSS: injected as <style> at runtime (CSP allows 'unsafe-inline').
        // Only woff2 fonts are inlined — Chromium always picks woff2 from the
        // src() list, so the woff/ttf fallback URLs are left unresolved on
        // purpose to keep the bundle small.
        test: /\.css$/,
        use: [
          'style-loader',
          { loader: 'css-loader', options: { url: { filter: (url) => url.endsWith('.woff2') } } },
        ],
      },
      {
        test: /\.woff2$/,
        type: 'asset/inline',
      },
    ],
  },
  devtool: 'nosources-source-map',
};

module.exports = [extensionConfig, webviewConfig];
