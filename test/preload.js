// The tests share the database of the development stack with its product container: they seal and
// open the secrets with the same key (docker/docker-compose.yml, mise.toml).
process.env.APIM_SECRETS_KEY ??= 'development-only-secrets-key';
