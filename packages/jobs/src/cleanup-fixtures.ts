import { createPool, withOrg } from "@rootset/database";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

const owner = createPool(process.env.ROOTSET_TEST_DATABASE_URL!, 2);
const worker = createPool(process.env.ROOTSET_TEST_DATABASE_URL!, 2);
const endpoints = [
  process.env.ROOTSET_S3_ENDPOINT,
  "http://127.0.0.1:59010",
].filter(
  (value, index, list) => Boolean(value) && list.indexOf(value) === index,
);
const clients = endpoints.map(
  (endpoint) =>
    new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.ROOTSET_S3_ACCESS_KEY!,
        secretAccessKey: process.env.ROOTSET_S3_SECRET_KEY!,
      },
    }),
);
let count = 0;
try {
  const organisations = (
    await owner.query<{ id: string }>(
      "SELECT id FROM rootset_control.organisations WHERE name='Jobs integration '||id",
    )
  ).rows;
  for (const org of organisations) {
    const artifacts = await withOrg(worker, org.id, async (client) => {
      await client.query(
        "UPDATE rootset_control.jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE state IN ('queued','running')",
      );
      return (
        await client.query<{ id: string; object_key: string }>(
          "SELECT id,object_key FROM rootset_control.artifacts",
        )
      ).rows;
    });
    for (const artifact of artifacts) {
      if (!artifact.object_key.startsWith(`rootset/${org.id}/`))
        throw new Error(
          "Test cleanup refused an object outside its fixture namespace",
        );
      for (const client of clients)
        await client.send(
          new DeleteObjectCommand({
            Bucket: process.env.ROOTSET_S3_BUCKET!,
            Key: artifact.object_key,
          }),
        );
      await withOrg(worker, org.id, (client) =>
        client.query(
          "UPDATE rootset_control.artifacts SET state='deleted' WHERE id=$1",
          [artifact.id],
        ),
      );
      count++;
    }
    await withOrg(worker, org.id, (client) =>
      client.query("UPDATE rootset_control.backups SET state='deleted'"),
    );
  }
  console.log(
    JSON.stringify({
      fixtureOrganisations: organisations.length,
      removedArtifactRecords: count,
    }),
  );
} finally {
  clients.forEach((client) => client.destroy());
  await Promise.all([owner.end(), worker.end()]);
}
