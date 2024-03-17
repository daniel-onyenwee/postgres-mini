import { PostgresInstanceOptions, PostgresObject } from "../global.js"
import AsyncExitHook from "async-exit-hook"
import { generateId as generatePostgresInstanceID, PostgresInstance } from "./utils/index.js"
import { findFreePorts } from "find-free-ports"

const defaultsPostgresInstanceOptions: PostgresInstanceOptions = {
    port: 5432,
    databaseDir: "./data/db",
    user: "postgres",
    overwriteDatabaseDir: false,
    password: "password",
    initdbFlags: [],
    postgresFlags: [],
    persistent: true,
    createPostgresUser: false,
    onLog: console.log,
    onError: console.error,
};

const PostgresInstanceMap: Map<string, PostgresInstance> = new Map<string, PostgresInstance>()

export const Postgres: PostgresObject = {
    async create(id?: string | null, options?: Partial<PostgresInstanceOptions> | null) {
        id = id || generatePostgresInstanceID()
        options = options || {}

        options = {
            ...defaultsPostgresInstanceOptions,
            ...{ port: (await findFreePorts(1)).at(0) },
            ...options
        }

        if (PostgresInstanceMap.has(id)) {
            throw new Error(`Instance key '${id}' already in use`)
        }

        let instance = new PostgresInstance(id, options as PostgresInstanceOptions)

        PostgresInstanceMap.set(id, instance)

        return instance
    },
    get(id: string) {
        return PostgresInstanceMap.get(id)
    },
    delete(id: string) {
        PostgresInstanceMap.delete(id)
    },
    has(id: string) {
        return PostgresInstanceMap.has(id)
    },
    clear() {
        PostgresInstanceMap.clear()
    },
    ids() {
        return Array.from(PostgresInstanceMap.keys())
    },
    forEach(cb: (instance: PostgresInstance, id: string, postgres: PostgresObject) => void) {
        PostgresInstanceMap.forEach((value, key) => cb(value, key, this))
    },
    instances() {
        return Array.from(PostgresInstanceMap.values())
    },
    async stop(id: string) {
        let postgresInstance = PostgresInstanceMap.get(id)

        if (postgresInstance) {
            await postgresInstance.stop()
        }
    },
    async stopAll() {
        await Promise.all([...PostgresInstanceMap.values()].map((instance) => {
            instance.stop()
        }))
    }
}

/**
 * This script should be called when a Node script is exited, so that we can
 * nicely shutdown all potentially started postgres instance, and we don't end up with
 * zombie processes.
 */
async function gracefulShutdown(done: () => void) {
    // Loop through all instances, stop them, and await the response
    await Promise.all([...PostgresInstanceMap.values()].map((instance) => {
        return instance.stop()
    }))

    // Let NodeJS know we're done
    done()
}

// Register graceful shutdown function
AsyncExitHook(gracefulShutdown)

export { PostgresInstance, generateId as generatePostgresInstanceID } from "./utils/index.js"
export { PostgresInstanceOptions, type PostgresObject } from "../global.js"
export default Postgres