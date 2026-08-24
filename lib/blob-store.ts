/**
 * Azure Blob Storage behind the same interface as the Cloudflare R2 binding.
 *
 * The application only ever calls `put`, `get` and `delete` on this binding (see
 * `R2Bucket` in `types/cloudflare.d.ts`), and only from the two upload routes.
 * Matching the shape keeps those call sites unchanged.
 */
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

let container: ContainerClient | null = null;

function getContainer(): ContainerClient {
  if (container) return container;
  const containerName = process.env.AZURE_STORAGE_CONTAINER ?? "uploads";
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  // Production authenticates with the Container App's managed identity, so no
  // storage key is ever held as a secret. The connection string is the local and
  // CI path (Azurite or a development account).
  const service = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : new BlobServiceClient(
        `https://${requireEnv("AZURE_STORAGE_ACCOUNT")}.blob.core.windows.net`,
        new DefaultAzureCredential(),
      );
  container = service.getContainerClient(containerName);
  return container;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to reach blob storage`);
  return value;
}

async function toBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export const blobBucket: R2Bucket = {
  async put(key, value, options) {
    const blob = getContainer().getBlockBlobClient(key);
    await blob.uploadData(Buffer.from(value), {
      blobHTTPHeaders: options?.httpMetadata?.contentType
        ? { blobContentType: options.httpMetadata.contentType }
        : undefined,
    });
    return { key };
  },

  async get(key) {
    const blob = getContainer().getBlockBlobClient(key);
    try {
      const download = await blob.download();
      if (!download.readableStreamBody) return null;
      // The route streams `body` straight into a Response, so the Node stream is
      // buffered once and re-exposed as a web ReadableStream.
      const buffered = await toBuffer(download.readableStreamBody);
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(buffered));
            controller.close();
          },
        }),
        httpMetadata: { contentType: download.contentType },
        size: buffered.byteLength,
      };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  },

  async delete(key) {
    await getContainer().getBlockBlobClient(key).deleteIfExists();
  },
};
