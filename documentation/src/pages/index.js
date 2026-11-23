import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';
import styles from './index.module.css';

const capabilities = [
  {
    kicker: 'Catalogue',
    title: 'One API, N plans, N auth mechanisms',
    body: 'An API carries its routes once; its plans carry the policy — auth mechanism, rate limit, quotas, resource filtering, visibility. Adding a tier is a catalogue operation, never an infrastructure one.',
  },
  {
    kicker: 'Lifecycle',
    title: 'Edit a draft, publish a snapshot',
    body: 'You always edit a draft. Publishing freezes an immutable, dated snapshot; deploying pushes that snapshot to the gateway after showing its diff. Rollback is the redeployment of an earlier snapshot.',
  },
  {
    kicker: 'Subscriptions',
    title: 'An approval workflow that is yours',
    body: 'Automatic or manual review, a usage statement, terms of use, a request form made of typed fields. A subscription becomes an Otoroshi apikey only once it is accepted, and moves to an equivalent plan without changing its key.',
  },
  {
    kicker: 'Gateway',
    title: 'Never in the request path',
    body: 'The product projects policies into Otoroshi through its Admin API, and Otoroshi enforces them. Operations are asynchronous and replayable: if the product is down, traffic still flows.',
  },
  {
    kicker: 'Gateway',
    title: 'Transparent, not opaque',
    body: 'From any API you reach the Otoroshi entity it projects, read it, and see when someone changed it by hand: drift is detected, readable, and repaired by redeploying. Existing Otoroshi APIs can be adopted without being overwritten.',
  },
  {
    kicker: 'Portal',
    title: 'One developer portal per workspace',
    body: 'A themable catalogue with multilingual documentation, an OpenAPI reference rendered by Scalar with a try-it that uses the consumer\'s own credentials, applications, credentials, live quotas and usage.',
  },
  {
    kicker: 'Analytics',
    title: 'Usage in the catalogue\'s vocabulary',
    body: 'An ingester receives Otoroshi events and attributes every call to its API, plan, subscription and application at ingestion — dashboards speak of products and plans, not of routes.',
  },
  {
    kicker: 'GitOps',
    title: 'Everything is administrable by program',
    body: 'The console is a client of the admin API, so every action replays from the CLI. APIs are declarative documents you can apply, and remote catalogs — HTTP, git or S3 — reconcile them on a schedule.',
  },
  {
    kicker: 'Open',
    title: 'Apache 2.0 across the critical path',
    body: 'Audit, drift, API products, multi-tenancy, shared policy groups — what other platforms gate behind a licence ships open, on top of an open gateway.',
  },
];

const layers = [
  { num: '01', name: 'Describe', desc: 'An API, its resources and backends, its plans, its documentation in any language — in a draft that never reaches the gateway.' },
  { num: '02', name: 'Publish', desc: 'Freeze an immutable snapshot of the draft, with the pinned versions of the shared policy groups it uses.' },
  { num: '03', name: 'Deploy', desc: 'Project the snapshot as an Otoroshi Api entity, after a dry run that shows what changes on the gateway.' },
  { num: '04', name: 'Consume', desc: 'Consumers subscribe from the portal; accepted subscriptions become apikeys; every call is counted and attributed.' },
];

const quickstart = `# the development stack: postgres, otoroshi 18.1, an echo backend, the product
mise run install && mise run up && mise run demo

# declare an api from a file, publish and deploy it
mise run cli apply default -f examples/petstore.yaml --publish --deploy

# console:  http://localhost:9000/backoffice/   (admin@otoroshi.io / password)
# portal:   http://localhost:9000/default/`;

function Hero() {
  return (
    <header className={styles.hero}>
      <div className="container">
        <div className={styles.heroLayout}>
          <div>
            <div className={styles.heroEyebrow}>Cloud APIM · for Otoroshi</div>
            <Heading as="h1" className={styles.heroTitle}>
              <span className={styles.heroAccent}>API management</span> for Otoroshi
            </Heading>
            <p className={styles.heroSubtitle}>
              An API management console and a developer portal on top of the Otoroshi gateway. Describe your APIs as
              products, publish them, let consumers subscribe and follow their usage — without ever opening the
              gateway, and without the product ever standing in the request path.
            </p>
            <div className={styles.heroButtons}>
              <Link className={styles.buttonPrimary} to="/docs/overview">
                Read the docs
              </Link>
              <Link className={styles.buttonGhost} to="/docs/quickstart">
                Quickstart
              </Link>
              <Link className={styles.buttonGhost} to="/docs/tutorial">
                Tutorial
              </Link>
              <Link className={styles.buttonGhost} href="https://github.com/cloud-apim/otoroshi-api-management">
                GitHub
              </Link>
            </div>
          </div>
          <img className={styles.heroLogo} src={require('@site/static/img/logo.svg').default} alt="" />
        </div>
      </div>
    </header>
  );
}

function Layers() {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.sectionTag}>How it works</div>
        <Heading as="h2" className={styles.sectionTitle}>
          From a description to traffic
        </Heading>
        <p className={styles.sectionLede}>
          Three objects with three lifetimes — the draft you edit, the snapshots you publish, the deployment that
          references one of them — and a gateway that only ever receives what was published.
        </p>
        <div className={styles.layers}>
          {layers.map((layer) => (
            <div className={styles.layer} key={layer.num}>
              <span className={styles.layerNum}>{layer.num}</span>
              <span className={styles.layerName}>{layer.name}</span>
              <p className={styles.layerDesc}>{layer.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Capabilities() {
  return (
    <section className={`${styles.section} ${styles.sectionAlt}`}>
      <div className="container">
        <div className={styles.sectionTag}>Capabilities</div>
        <Heading as="h2" className={styles.sectionTitle}>
          Two faces of one thing
        </Heading>
        <p className={styles.sectionLede}>
          A console where producers describe products and plans and review subscriptions, and a portal where consumers
          discover, subscribe, try and follow their consumption — over one admin API.
        </p>
        <div className={styles.grid}>
          {capabilities.map((c) => (
            <div className={styles.card} key={c.title}>
              <div className={styles.cardKicker}>{c.kicker}</div>
              <div className={styles.cardTitle}>{c.title}</div>
              <p className={styles.cardBody}>{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Start() {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.sectionTag}>Get going</div>
        <Heading as="h2" className={styles.sectionTitle}>
          A running catalogue in a few commands
        </Heading>
        <p className={styles.sectionLede}>
          The development stack brings an Otoroshi 18.1 gateway, PostgreSQL, a demo backend and the product. The
          quickstart starts it; the tutorial walks through the console, the portal and a call through the gateway, a
          screen at each step.
        </p>
        <div className={styles.snippet}>
          <CodeBlock language="bash">{quickstart}</CodeBlock>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <Layout
      title="API management for Otoroshi"
      description="The API management console and developer portal for the Otoroshi API gateway: products, plans, subscriptions, credentials, a developer portal per workspace, analytics and GitOps.">
      <Hero />
      <main>
        <Layers />
        <Capabilities />
        <Start />
      </main>
    </Layout>
  );
}
