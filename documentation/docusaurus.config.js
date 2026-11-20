// @ts-check
import { themes as prismThemes } from 'prism-react-renderer';

const repo = 'https://github.com/cloud-apim/otoroshi-api-management';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Otoroshi API Management',
  tagline: 'The API management console and developer portal for Otoroshi',
  favicon: 'img/favicon.svg',

  url: 'https://cloud-apim.github.io',
  // the path of GitHub Pages; DOCS_BASE_URL=/ for the archive of a release, served from its root
  baseUrl: process.env.DOCS_BASE_URL || '/otoroshi-api-management/',

  organizationName: 'cloud-apim',
  projectName: 'otoroshi-api-management',

  onBrokenLinks: 'throw',

  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
      onBrokenMarkdownImages: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          editUrl: `${repo}/edit/main/documentation/`,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themes: [
    [
      // offline index — no Algolia account, no third-party request from the docs
      /** @type {import("@easyops-cn/docusaurus-search-local").PluginOptions} */
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        language: ['en'],
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        indexBlog: false,
      },
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/logo.svg',
      colorMode: {
        defaultMode: 'dark',
        disableSwitch: false,
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'API Management',
        logo: {
          alt: 'Otoroshi API Management',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docsSidebar',
            position: 'left',
            label: 'Documentation',
          },
          { href: repo, label: 'GitHub', position: 'right' },
          { href: 'https://www.cloud-apim.com', label: 'Cloud APIM', position: 'right' },
          {
            href: 'https://maif.github.io/otoroshi/manual/docs/getting-started',
            label: 'Otoroshi',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Overview', to: '/docs/overview' },
              { label: 'Quickstart', to: '/docs/quickstart' },
              { label: 'Install', to: '/docs/install' },
              { label: 'GitOps', to: '/docs/gitops/cli' },
            ],
          },
          {
            title: 'Community',
            items: [
              { label: 'Discord', href: 'https://discord.cloud-apim.com' },
              { label: 'Twitter', href: 'https://twitter.com/cloudapim' },
              { label: 'Youtube', href: 'https://www.youtube.com/@CloudAPIM' },
            ],
          },
          {
            title: 'More',
            items: [
              { label: 'Cloud APIM', href: 'https://www.cloud-apim.com' },
              { label: 'Blog', href: 'https://blog.cloud-apim.com' },
              { label: 'GitHub', href: repo },
              {
                label: 'Otoroshi',
                href: 'https://maif.github.io/otoroshi/manual/docs/getting-started',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Cloud APIM. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        // only what the docs actually use — prism resolves no dependencies here
        additionalLanguages: ['bash', 'shell-session', 'json', 'yaml', 'http'],
      },
    }),
};

export default config;
