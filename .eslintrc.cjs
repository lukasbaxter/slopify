module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true, browser: true },
  ignorePatterns: ['dist', 'node_modules', 'fixtures/music'],
  rules: { '@typescript-eslint/no-explicit-any': 'off' },
};
