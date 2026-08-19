// Commit-message rules, enforced by the husky `commit-msg` hook. The authoritative statement of these
// rules is agents/conventions/commits.md — keep the two in sync.
//
// Scopes are deliberately open rather than enumerated so a new workspace or area needs no change here;
// a repository-wide change carries no scope. A language, target, or location word is never a type.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-empty': [2, 'always'],
    'footer-empty': [2, 'always'],
    'scope-case': [2, 'always', 'lower-case'],
    'scope-empty': [0],
    'type-enum': [
      2,
      'always',
      ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'],
    ],
  },
};
