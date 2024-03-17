# postgres-mini

A package to run an mini postgres database right from NodeJS.

## Install

```bash
npm i postgres-mini
```

## Usage

```ts
import Postgres from 'postgres-mini'

async function main() {
    // Create a postgres instance.
    const pgInstance = Postgres.create()

    // Initialize the postgres instance and set all configuration  
    await pgInstance.initialize()

    // Start the postgres instances
    await pgInstance.start()

    // Create a database
    await pgInstance.createDatabase("PERSON")

    // Make a query
    const result = await pgInstance.query("SELECT datname FROM pg_database")

    // Stop the postgres instances
    await pgInstance.stop()
}

main()

```

## Documentation

## Credits

Postgres mini was created based on inspiration from Lei Nelissen [embedded-postgres](https://github.com/leinelissen/embedded-postgres) package.
