import crypto from "node:crypto"
import { join } from "node:path"
import { ChildProcess, spawn } from "node:child_process"
import pg, { QueryResultRow } from "pg"
const { Client } = pg
import fs from "fs/promises"
import { existsSync } from "fs"
import {
    installPostgres,
    getPostgresBinaries,
    PostgresBinaries
} from "window-postgres-installer"
import execAsync from "./exec-async.js"
import { platform, tmpdir, userInfo } from "node:os"
import { PostgresInstanceOptions } from "../../global.js"

export default class PostgresInstance {
    #authMethod: string = "password"
    #id: string
    #options: PostgresInstanceOptions
    #process?: ChildProcess
    #isRootUser: boolean
    #isInitialize: boolean = false
    #hasPostgresStarted: boolean = false

    constructor(id: string, options: PostgresInstanceOptions) {
        this.#id = id
        this.#options = options
        this.#isRootUser = userInfo().uid === 0
    }

    /**
     * Start the Postgres instance. It is automatically
     * shut down when the script exits.
     */
    async start(): Promise<void> {
        await installPostgres()

        let { postgres } = await getPostgresBinaries() as PostgresBinaries

        // Optionally retrieve the uid and gid
        const permissionIds = await this.#getUidAndGid()
            .catch(() => {
                throw new Error("Postgres cannot run as a root user. embedded-postgres could not find a postgres user to run as instead. Consider using the `createPostgresUser` option.");
            })

        // Greedily make the file executable, in case it is not
        await fs.chmod(postgres, "755")

        await new Promise<void>((resolve, reject) => {
            // Spawn a postgres server
            this.#process = spawn(postgres, [
                "-D",
                this.#options.databaseDir,
                "-p",
                this.#options.port.toString(),
                ...this.#options.postgresFlags,
            ], { ...permissionIds })

            this.#process.stderr?.on("data", (chunk: Buffer) => {
                const message = chunk.toString("utf-8")
                this.#options.onLog(message)

                // Check for the right message to determine server start
                if (message.includes("database system is ready to accept connections")) {
                    this.#hasPostgresStarted = true
                    resolve()
                }
            })

            this.#process.on("close", () => {
                reject()
            })
        })
    }

    /**
     * Stop the postgres instance.
     */
    async stop(): Promise<void> {
        if (!this.#process) {
            return
        }

        if (!this.#hasPostgresStarted) {
            return
        }

        // Kill the existing postgres process
        await new Promise<void>((resolve) => {
            // Register a handler for when the process finally exists
            this.#process?.on("exit", resolve)

            if (platform() === "win32") {
                if (!this.#process?.pid) {
                    throw new Error("Could not find process PID")
                }

                // Actually kill the process using the Windows taskkill command
                spawn("taskkill", ["/pid", this.#process.pid.toString(), "/f", "/t"])
            } else {
                this.#process?.kill("SIGINT")
            }
        })

        // Additional work if database is not persistent
        if (this.#options.persistent === false) {
            // Delete the data directory
            await fs.rm(this.#options.databaseDir, { recursive: true, force: true });
        }

        this.#process = undefined
        this.#hasPostgresStarted = false
        this.#isInitialize = this.#isInitialize && !this.#options.persistent
    }

    /**
     * Initialize the postgres instance.
     */
    async initialize(): Promise<void> {
        if (this.#isInitialize) {
            return
        }

        await installPostgres()

        let { initdb } = await getPostgresBinaries() as PostgresBinaries

        await this.#checkForRootUser()

        let permissionIds = await this.#getUidAndGid()
            .catch(() => ({}))

        if (this.#options.createPostgresUser && !("uid" in permissionIds) && !("gid" in permissionIds)) {
            try {
                // Create the group and user
                await execAsync("groupadd postgres")
                await execAsync("useradd -g postgres postgres")

                // Re-try the permission ids now the user exists
                permissionIds = await this.#getUidAndGid();
            } catch (err) {
                this.#options.onError(err);
                throw new Error("Failed to create and initialize a postgres user on this system.")
            }
        }

        if (this.#options.createPostgresUser) {
            if (!('uid' in permissionIds)) {
                throw new Error("Failed to retrieve the uid for the newly created user.")
            }

            await this.#createDataDir(permissionIds as { uid: number, gid: number })

        }

        let passwordFile = await this.#createPasswordFile()

        await this.#initDB(initdb, passwordFile, permissionIds as { uid: number, gid: number })
    }

    /**
     * Create a database with a given name on the postgres instance.
     */
    async createDatabase(databaseName: string): Promise<void> {
        if (!this.#process) {
            throw new Error('Your postgres instance must be running before you can create a database')
        }

        const client = this.client()
        await client.connect()
        await client.query(`CREATE DATABASE ${client.escapeIdentifier(databaseName)}`)

        await client.end()
    }

    /**
     * Make a query on the postgres instance.
     * 
     * @param database The database that the postgres client should perform the query from 
     * @param host The host that the postgres client should connect to
     */
    async query<T extends QueryResultRow = any>(queryTextOrConfig: string, values: any[] = [], database = "postgres", host = "localhost"): Promise<pg.QueryResult<T>> {
        if (!this.#process) {
            throw new Error('Your postgres instance must be running before you can create a database')
        }

        const client = this.client(database, host)
        await client.connect()
        const query = await client.query<T>(queryTextOrConfig, values)

        await client.end()

        return query
    }

    /**
     * Determine if database with a given name on the postgres instance exist.
     */
    async hasDatabase(databaseName: string): Promise<boolean> {
        let dbQuery = await this.query("SELECT * FROM  pg_catalog.pg_database WHERE datname=$1::text", [databaseName])

        if (dbQuery.rowCount) {
            if (dbQuery.rowCount > 0) {
                return true
            }
        }

        return false
    }

    /**
     * Drop a database with a given name on the postgres instance.
     */
    async dropDatabase(databaseName: string): Promise<void> {
        if (!this.#process) {
            throw new Error('Your postgres instance must be running before you can create a database')
        }

        const client = this.client()
        await client.connect()
        await client.query(`DROP DATABASE ${client.escapeIdentifier(databaseName)}`)

        await client.end()
    }

    /**
     * Create the data directory and have the user own it.
     */
    async #createDataDir(permissionIds: { uid: number, gid: number }): Promise<void> {
        await fs.mkdir(this.#options.databaseDir, { recursive: true })
        await fs.chown(this.#options.databaseDir, permissionIds.uid, permissionIds.gid)
    }

    /**
     * Create a file on disk that contains the password in plaintext.
     * @returns password file path
     */
    async #createPasswordFile(): Promise<string> {
        const randomId = crypto.randomBytes(6).readUIntLE(0, 6).toString(36)
        const passwordFile = join(tmpdir(), `pg-password-${randomId}`)
        await fs.writeFile(passwordFile, this.#options.password + "\n")

        return passwordFile
    }

    /**
     * Create a node postgres client using the existing postgres instance configuration.
     * 
     * @param database The database that the postgres client should connect to
     * @param host The host that should be pre-filled in the connection options
     * @returns Client
     */
    client(database = "postgres", host = "localhost"): pg.Client {
        // Create client
        const client = new Client({
            user: this.#options.user,
            password: this.#options.password,
            port: this.#options.port,
            host,
            database,
        })

        // Log errors rather than throwing them so that embedded-postgres has
        // enough time to actually shutdown.
        client.on('error', this.#options.onError)

        return client
    }

    /**
     * Initialize postgres database directory
     */
    async #initDB(initdbExe: string, passwordFile: string, permissionIds: { uid: number, gid: number }): Promise<void> {
        if (existsSync(this.#options.databaseDir)) {
            if (this.#options.overwriteDatabaseDir) {
                await fs.rm(this.#options.databaseDir, { recursive: true, force: true })
            } else {
                throw new Error(`Directory ${this.#options.databaseDir} exists`)
            }
        }

        // Greedily make the file executable, in case it is not
        await fs.chmod(initdbExe, "755")

        await new Promise<void>((resolve, reject) => {
            const process = spawn(initdbExe, [
                `--pgdata=${this.#options.databaseDir}`,
                `--auth=${this.#authMethod}`,
                `--username=${this.#options.user}`,
                `--pwfile=${passwordFile}`,
                ...this.#options.initdbFlags,
            ], { stdio: "inherit", ...permissionIds, })

            process.on("exit", (code) => {
                if (code === 0) {
                    resolve()
                } else {
                    reject(`Postgres init script exited with code ${code}. Please check the logs for extra info. The data directory might already exist.`)
                }
            })
        })

        await fs.unlink(passwordFile)
        this.#isInitialize = true
    }

    async #checkForRootUser() {
        if (!this.#isRootUser) {
            return
        }

        // Attempt to retrieve the uid and gid for the postgres user. This check
        // will throw and error when the postgres user doesn't exist
        try {
            await this.#getUidAndGid()
        } catch (err) {
            // No user exists, but check that a postgres user should be created
            if (!this.#options.createPostgresUser) {
                throw new Error("You are running this script as root. Postgres does not support running as root. If you wish to continue, configure postgres instance to create a Postgres user by setting the `createPostgresUser` option to true.")
            }
        }
    }

    /**
     * Retrieve the uid and gid for a particular user
     */
    async #getUidAndGid(name = "postgres") {
        if (!this.#isRootUser) {
            return {} as Record<string, never>
        }

        const [uid, gid] = await Promise.all([
            execAsync(`id -u ${name}`).then(Number.parseInt),
            execAsync(`id -g ${name}`).then(Number.parseInt),
        ])

        return { uid, gid }
    }

    /**
     * Get the postgres instance id.
     */
    get id(): string {
        return this.#id
    }
}