'use strict';

const BaseComponent = require('../base-component');
const api = require('../api');
const bson = require('bson');
const runTests = require('../_methods/runTests');
const setLevel = require('../_methods/setLevel');
const template = require('./level.html');
const vanillatoasts = require('vanillatoasts');

// Only import lighter in browser (which works), this require() fails with "ESM required"
// in Node.js tests.
const lighter =
  typeof window === 'undefined' ? null : require('@code-hike/lighter');

const defaultPolarCode = `
actor User { }

resource Organization { 
    roles = ["admin", "member"];
    permissions = ["read", "add_member"];

    # role hierarchy:
    # admins inherit all member permissions
    "member" if "admin";

    # org-level permissions
    "read" if "member";
    "add_member" if "admin";
}

resource Repository { 
    permissions = [
        "read", "write", "delete"
    ];
    roles = ["reader", "admin", "maintainer", "editor"];
    relations = { organization: Organization };

    "reader" if "member" on "organization";
    "admin" if "admin" on "organization";
    "reader" if "editor";
    "editor" if "maintainer";
    "maintainer" if "admin";

    # reader permissions
    "read" if "reader";

    # editor permissions
    "write" if "editor";
}

has_permission(_: Actor, "read", repo: Repository) if
    is_public(repo, true);


has_permission(actor: Actor, "delete", repo: Repository) if
    has_role(actor, "admin", repo) and
    is_protected(repo, false);
`.trim();

module.exports = (app) =>
  app.component('level', {
    inject: ['state'],
    props: ['status'],
    extends: BaseComponent,
    name: 'level',
    data: () => ({
      userId: null,
      attributeFact: {
        resourceType: null,
        resourceId: null,
        attribute: null,
        attributeValue: null,
      },
      roleFact: {
        resourceType: null,
        resourceId: null,
        role: null,
      },
      deleteInProgress: false,
      showDeleteAllModal: false,
      highlightedCode: [],
    }),
    template,
    computed: {
      polarCode() {
        return this.highlightedCode
          .map((line) => {
            return line
              .map(
                (chunk) =>
                  `<span style="${stringifyStyle(chunk.style)}">${chunk.content}</span>`,
              )
              .join('');
          })
          .join('\n');
      },
      allResources() {
        let ret = ['Organization', 'Repository', 'User'];
        if (this.state.currentLevel?.repositories?.length === 0) {
          ret = ret.filter((type) => type !== 'Organization');
        }
        if (!this.state.currentLevel?.groups) {
          ret = ret.filter((type) => type !== 'User');
        }
        return ret;
      },
      allUsers() {
        return [...new Set(this.state.constraints.map((c) => c.userId))];
      },
      allRoles() {
        if (this.roleFact.resourceType === 'Organization') {
          return ['admin', 'member'];
        }
        if (this.roleFact.resourceType === 'Repository') {
          return ['reader', 'admin', 'maintainer', 'editor'];
        }
        return [
          'reader',
          'admin',
          'maintainer',
          'editor',
          'member',
          'superadmin',
        ];
      },
      allAttributes() {
        if (this.attributeFact.resourceType === 'Organization') {
          return ['has_default_role'];
        }
        if (this.attributeFact.resourceType === 'Repository') {
          return ['is_public', 'is_protected'];
        }
        if (this.attributeFact.resourceType === 'User') {
          return ['has_group'];
        }

        return [];
      },
      allAttributeValues() {
        if (this.attributeFact.resourceType === 'Organization') {
          return ['reader', 'admin', 'maintainer', 'editor'];
        }
        if (this.attributeFact.resourceType === 'Repository') {
          return ['true', 'false'];
        }
        if (this.attributeFact.resourceType === 'User') {
          return this.state.currentLevel?.groups ?? [];
        }

        return [];
      },
      resourceIds() {
        if (this.attributeFact.resourceType === 'Organization') {
          return this.state.organizations;
        }
        if (this.attributeFact.resourceType === 'Repository') {
          return this.state.repositories;
        }
        if (this.attributeFact.resourceType === 'User') {
          return [...new Set(this.state.constraints.map((c) => c.userId))];
        }

        return [];
      },
      level() {
        return this.state.currentLevel;
      },
      testsInProgress() {
        return (
          this.state.constraints.length > 0 &&
          this.state.constraints.length !== this.state.results.length
        );
      },
      parForLevel() {
        const parForLevel = this.state.currentLevel?.par;
        const par = this.state.facts.length - parForLevel;

        return par < 0 ? par : `+${par}`;
      },
      isGlobalRole() {
        return this.roleFact.role === 'superadmin';
      },
    },
    watch: {
      'roleFact.resourceType'() {
        if (!this.allRoles.includes(this.roleFact.role)) {
          this.roleFact.role = null;
        }
      },
      'state.currentLevel': async function (currentLevel) {
        this.highlightedCode = [];
        const { polarCode } = currentLevel;
        const result =
          lighter == null
            ? polarCode
            : await lighter.highlight(polarCode, 'polar', 'github-light');
        this.highlightedCode = result.lines;
      },
    },
    methods: {
      async addAttributeFact() {
        const { attributeFact } = this;
        if (
          !attributeFact.resourceType ||
          !attributeFact.resourceId ||
          !attributeFact.attribute ||
          attributeFact.attributeValue == null
        ) {
          vanillatoasts.create({
            title: 'Missing a required field',
            icon: '/images/failure.jpg',
            timeout: 5000,
            positionClass: 'bottomRight',
          });
          return;
        }

        const resourceType = attributeFact.resourceType;
        const factType = 'attribute';
        await api
          .put('/api/tell', {
            sessionId: this.state.sessionId,
            factType,
            userId: this.userId,
            resourceType,
            ...this.attributeFact,
          })
          .then((res) => res.data);
        this.state.facts.push({
          _id: new bson.ObjectId(),
          factType,
          userId: this.userId,
          resourceType,
          ...this.attributeFact,
        });

        this.attributeFact = {
          resourceId: null,
          attribute: null,
          attributeValue: null,
        };

        this.userId = null;

        await runTests(this.state);
      },
      displayRoleFact(fact) {
        if (fact.role === 'superadmin') {
          return `${fact.actorType || 'User'} ${fact.userId} has role ${fact.role}`;
        }
        return `${fact.actorType || 'User'} ${fact.userId} has role ${fact.role} on ${fact.resourceType} ${fact.resourceId}`;
      },
      displayAttributeFact(fact) {
        if (fact.attribute === 'has_group') {
          return `User ${fact.resourceId} belongs to Group ${fact.attributeValue}`;
        }
        const resourceType = fact.resourceType ?? 'Repository';
        return `${resourceType} ${fact.resourceId} has attribute ${fact.attribute} set to ${fact.attributeValue}`;
      },
      async deleteFact(fact) {
        this.deleteInProgress = true;
        try {
          const params = { ...fact };
          delete params._id;
          await api
            .put('/api/delete-fact', {
              sessionId: this.state.sessionId,
              ...params,
            })
            .then((res) => res.data);
          this.state.facts = this.state.facts.filter((f) => fact !== f);

          await runTests(this.state);
        } finally {
          this.deleteInProgress = false;
        }
      },
      async deleteAllFacts() {
        this.deleteInProgress = true;
        try {
          await api
            .put('/api/clear-context-facts', {
              sessionId: this.state.sessionId,
            })
            .then((res) => res.data);
          this.state.facts = [];

          await runTests(this.state);
        } finally {
          this.deleteInProgress = false;
        }
      },
      displayImageForTestResult(index) {
        if (!this.state.results[index]) {
          return '/images/loader.gif';
        }
        return this.state.results[index].pass
          ? '/images/check-green.svg'
          : '/images/error-red.svg';
      },
      async verifySolutionForLevel() {
        const { player } = await api
          .post('/api/verify-solution-for-level', {
            sessionId: this.state.sessionId,
            level: this.state.level,
          })
          .then((res) => res.data);

        await setLevel(player.levelsCompleted + 1, false, this.state);
        this.state.par = player.par;
        this.state.player = player;
        await runTests(this.state);
      },
    },
  });

function stringifyStyle(obj) {
  if (obj == null) {
    return '';
  }
  return Object.entries(obj)
    .map(([key, value]) => {
      return `${key}:${value}`;
    })
    .join(';');
}
