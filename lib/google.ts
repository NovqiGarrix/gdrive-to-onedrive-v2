import { google } from "googleapis";
import { REDIS_GOOGLE_TOKEN_KEY } from "../constant.ts";
import { MyError } from "../exceptions/MyError.ts";
import { googleTokenSchema } from "../schema.ts";
import { getRedisClient, oauth } from "../utils.ts";
import { MicrosoftAuthenticationProvider } from "./microsoft.ts";
import onedrive from "./onedrive.ts";

const drive = google.drive("v3");

const redis = await getRedisClient();
const microsoftClient = new MicrosoftAuthenticationProvider(redis);

async function ensureToken() {
    const token = await redis.get(REDIS_GOOGLE_TOKEN_KEY);
    if (!token) {
        throw new Error('Google access token not found. Please sign in again');
    }

    const parsedToken = googleTokenSchema.parse(JSON.parse(token));

    // Check if the expiry date is passed
    if (parsedToken.expiryDate < Date.now()) {
        // Get new token
        oauth.setCredentials({
            access_token: parsedToken.accessToken,
            refresh_token: parsedToken.refreshToken,
            expiry_date: parsedToken.expiryDate,
            token_type: 'Bearer',
        });

        const { res } = await oauth.getAccessToken();
        if (!res?.data) {
            throw new MyError()
                .internalServerError('Failed to get access token');
        }

        const { access_token, expiry_date } = res.data;
        if (!access_token) {
            throw new MyError()
                .internalServerError('Failed to get access token');
        }

        // Save the new token to redis
        await redis.set(REDIS_GOOGLE_TOKEN_KEY, JSON.stringify({
            ...parsedToken,
            accessToken: access_token,
            expiryDate: expiry_date
        }));

        oauth.setCredentials({
            access_token: access_token,
            refresh_token: parsedToken.refreshToken,
            expiry_date: expiry_date,
            token_type: 'Bearer',
        });
    } else {
        oauth.setCredentials({
            access_token: parsedToken.accessToken,
            refresh_token: parsedToken.refreshToken,
            expiry_date: parsedToken.expiryDate,
            token_type: 'Bearer',
        });
    }
}

async function getParent(fileId: string, _paths: string[] = []) {
    const paths = [..._paths];

    const file = await drive.files.get({
        auth: oauth,
        fileId,
        fields: 'name, parents'
    });

    const { parents, name } = file.data;
    const parentId = parents?.at(0)!;

    if (name === "My Drive") {
        return paths.join('/');
    }

    paths.push(name!);
    return getParent(parentId, paths);
}

async function getParentPath(fileId: string): Promise<string> {
    await ensureToken();

    const file = await drive.files.get({
        auth: oauth,
        fileId,
        fields: 'parents, kind, name'
    });

    const { parents } = file.data;

    const parentId = parents?.at(0)!;
    const parentPath = await getParent(parentId);

    return parentPath;
}

async function transfer(fileId: string, deleteToo: boolean = false) {

    const file = await drive.files.get({
        auth: oauth,
        fileId,
        fields: 'parents, name, webContentLink, size'
    });

    const { name, webContentLink } = file.data;

    const parentPath = await getParentPath(fileId);

    const res = await oauth.request<NodeJS.ReadableStream>({
        method: 'GET',
        url: webContentLink!,
        responseType: 'stream'
    });

    const g = await onedrive.items.uploadSimple({
        accessToken: await microsoftClient.getAccessToken(),
        filename: name!,
        parentPath: `novqigarrixdev/${parentPath}`,
        readableStream: res.data,
        // fileSize: Number(size!),
        // conflictBehavior: 'replace',
        // chunksToUpload: 50,
    });

    if (deleteToo) {
        console.log(`-------- DELETING ${name} --------`);
        await drive.files.delete({
            auth: oauth,
            fileId,
        });
        console.log(`-------- ${name} DELETED --------`);
    }

    console.log(`-------- ${g.name} UPLOADED --------`);

}

async function transferFiles() {

    try {

        await ensureToken();

        let driveFiles = await google.drive("v3").files.list({
            auth: oauth,
            pageSize: 10,
            fields: 'nextPageToken, files(id, name)',
            q: "mimeType != 'application/vnd.google-apps.folder' and trashed=false",
        });

        while (driveFiles.data.nextPageToken) {
            const { data: { files } } = driveFiles;

            for await (const file of files!) {
                console.log(`----- UPLOADING ${file.name}... ------`);
                await transfer(file.id!);
                console.log(`------ ${file.name} UPLOADED -------`);
            }

            console.log('GETTING ANOTHER FILES....');
            driveFiles = await google.drive("v3").files.list({
                auth: oauth,
                pageSize: 10,
                fields: 'nextPageToken, files(name, id, webContentLink)',
                q: "mimeType != 'application/vnd.google-apps.folder' and trashed=false",
                pageToken: driveFiles.data.nextPageToken
            });
        }

        console.log('ITS OVER...');

    } catch (error) {
        console.error(error);
    }

}

if (import.meta.main) {
    await transferFiles();

    // await list();
    // await download('https://drive.google.com/uc?id=1IE-2yeNqnqKkpWZruzZJ-n6k7kfaWgao&export=download');
    // console.log(await getParentPath('1IE-2yeNqnqKkpWZruzZJ-n6k7kfaWgao'));
    // await getParentPath('0AAI4RCCtKABSUk9PVA');
}



Deno.exit(0);

export default {
    ensureToken
}