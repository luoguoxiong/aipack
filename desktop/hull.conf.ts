import path from 'path';

export default {
  projectType: 'react',
  entry: path.resolve(__dirname, './src/index'),
  extraModuleRules: [
    {
      test: /\.svg$/,
      use: ['@svgr/webpack'],
    }],
};
