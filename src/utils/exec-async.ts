import { exec } from "node:child_process"

/**
 * A promisified version of the exec API that either throws on errors or returns
 * the string results from the executed command.
 */
export default async function execAsync(command: string) {
    return new Promise<string>((resolve, reject) => {
        exec(command, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}