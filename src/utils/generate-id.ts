import crypto from "node:crypto"

export default function generateId(): string {
    return crypto.randomBytes(6).readUIntLE(0, 6).toString(36)
}