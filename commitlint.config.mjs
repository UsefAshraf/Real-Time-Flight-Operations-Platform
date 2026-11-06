export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'repo',
        'ci',
        'docs',
        'deps',
        'domain',
        'config',
        'logger',
        'service-kit',
        'gateway',
        'flights',
        'airports',
        'passengers',
        'notifications',
        'simulator',
        'infra',
      ],
    ],
  },
};
