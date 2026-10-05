import fs from "node:fs/promises"

export async function readTranscriptTail(filePath: string, byteLimit: number) {
  const handle = await fs.open(filePath, "r")
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - byteLimit)
    const buffer = Buffer.alloc(Math.min(size, byteLimit))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.subarray(0, bytesRead).toString("utf8")
    // Drop the first partial JSONL record when reading from the middle of a file.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text
  } finally {
    await handle.close()
  }
}
