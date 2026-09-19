import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

let storageClient: S3Client | undefined;

export const getStorageClient = () => {
  if (!storageClient) {
    storageClient = new S3Client({
      endpoint: required("S3_ENDPOINT"),
      region: process.env.S3_REGION ?? "us-east-1",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: { accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY") },
    });
  }
  return storageClient;
};

export const getBucket = () => required("S3_BUCKET");

export const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export const assertStorageAvailable = async () => {
  await getStorageClient().send(new HeadBucketCommand({ Bucket: getBucket() }));
};

export const putPrivateObject = async (params: { key: string; body: Uint8Array | string; contentType: string; metadata?: Record<string, string> }) => {
  const input: PutObjectCommandInput = {
    Bucket: getBucket(), Key: params.key, Body: params.body, ContentType: params.contentType, Metadata: params.metadata,
  };
  await getStorageClient().send(new PutObjectCommand(input));
  const bytes = typeof params.body === "string" ? Buffer.from(params.body) : params.body;
  return { key: params.key, sha256: sha256(bytes), byteSize: bytes.byteLength };
};

export const getPrivateObject = async (key: string) => {
  const response = await getStorageClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
  if (!response.Body) throw new Error(`Storage object ${key} has no body`);
  return new Uint8Array(await response.Body.transformToByteArray());
};

export const getPrivateReadUrl = async (key: string, expiresIn = 300) =>
  getSignedUrl(getStorageClient(), new GetObjectCommand({ Bucket: getBucket(), Key: key }), { expiresIn });

export const deletePrivateObject = async (key: string) => {
  await getStorageClient().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
};
