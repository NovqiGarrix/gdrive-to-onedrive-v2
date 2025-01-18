import fs from 'node:fs';
import fsPromise from 'node:fs/promises';
import { MicrosoftAuthenticationProvider } from "./microsoft.ts";
import onedrive from "./onedrive.ts";

const microsoftAuth = new MicrosoftAuthenticationProvider();

Deno.test('Upload session', async () => {

    const filename = `test.png`;

    const info = await fsPromise.stat(filename);
    const readableStream = fs.createReadStream(filename);

    await onedrive.items.uploadSession({
        readableStream: readableStream,
        accessToken: await microsoftAuth.getAccessToken(),
        filename,
        parentPath: `UploadTest`,
        fileSize: info.size,
        chunksToUpload: 50,
        conflictBehavior: 'replace'
    }, (bytes) => {
        console.log(`${bytes / (1024 * 1024)} MB uploaded`);
    });

    readableStream.close();
    console.log('Upload completed');

});