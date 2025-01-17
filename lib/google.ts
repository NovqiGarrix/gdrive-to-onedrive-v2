import { google } from "googleapis";
import { REDIS_GOOGLE_TOKEN_KEY } from "../constant.ts";
import { MyError } from "../exceptions/MyError.ts";
import { googleTokenSchema } from "../schema.ts";
import { getRedisClient, oauth } from "../utils.ts";
import { MicrosoftAuthenticationProvider } from "./microsoft.ts";
import onedrive from "./onedrive.ts";

const ROOT_FOLDER_NAME = 'novrianto254v2';

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

    if (!fileId) {
        return paths.reverse().join('/');
    }

    const file = await drive.files.get({
        auth: oauth,
        fileId,
        fields: 'name, parents'
    });

    const { parents, name } = file.data;

    const parentId = parents?.at(0)!;

    if (name === "My Drive") {
        return paths.reverse().join('/');
    }

    paths.push(name!);
    return getParent(parentId, paths);
}

async function getParentPath(fileId: string): Promise<string> {

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

const ONEDRIVE_PARENT_ID = '01COHAPYWLQJ3QKRKXABB27U6DVV6YQYAC';
const GOOGLE_DRIVE_PARENT_ID = '0AAI4RCCtKABSUk9PVA';

async function checkIfFileExists(filename: string, googleParentId?: string) {

    let parentPath: string | null = null;

    if (googleParentId) {
        parentPath = await getParent(googleParentId);
    }

    let parentId = ONEDRIVE_PARENT_ID;

    if (parentPath) {
        // Find the id of the parent folder
        // https://graph.microsoft.com/v1.0/me/drive/root:/${ROOT_FOLDER_NAME}

        const resp = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${ROOT_FOLDER_NAME}/${parentPath}`, {
            headers: {
                Authorization: `Bearer ${await microsoftClient.getAccessToken()}`,
                'Content-Type': 'application/json'
            }
        });

        if (!resp.ok) {
            if (resp.status === 404) {
                return false;
            }

            throw new Error('Failed to get parent folder id');
        }

        const { id } = await resp.json();
        console.log(`Got parent id: ${id}`);
        parentId = id;
    }

    const url = new URL(`https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children`);
    url.searchParams.set('select', 'name');
    const resp = await fetch(url, {
        headers: {
            Authorization: `Bearer ${await microsoftClient.getAccessToken()}`,
            'Content-Type': 'application/json'
        }
    });

    const data = await resp.json();

    if (!resp.ok) {
        throw new Error(data.error_description);
    }

    const { value }: { value: Array<{ name: string }> } = data;
    return value.some((v) => v.name === filename);

}

interface TransferParams {
    file: {
        id: string;
        name: string;
        webContentLink: string;
        parents: string[];
    }
    deleteToo?: boolean;
}

async function transfer(params: TransferParams) {

    const { file, deleteToo = false } = params;

    const { id, name, webContentLink, parents } = file;
    const insideFolder = parents?.at(0) !== GOOGLE_DRIVE_PARENT_ID;

    if (await checkIfFileExists(name!, insideFolder ? parents?.at(0)! : undefined)) {
        console.log(`-------- ${name} ALREADY EXISTS --------`);
        return;
    }

    const parentPath = await getParentPath(id);

    const res = await oauth.request<NodeJS.ReadableStream>({
        method: 'GET',
        url: webContentLink!,
        responseType: 'stream'
    });

    const g = await onedrive.items.uploadSimple({
        accessToken: await microsoftClient.getAccessToken(),
        filename: name!,
        parentPath: `${ROOT_FOLDER_NAME}/${parentPath}`,
        readableStream: res.data
    });

    if (deleteToo) {
        console.log(`-------- DELETING ${name} --------`);
        await drive.files.delete({
            auth: oauth,
            fileId: id,
        });
        console.log(`-------- ${name} DELETED --------`);
    }

    console.log(`-------- ${g.name} UPLOADED --------`);

}

const PAGE_SIZE = 50;

async function transferFiles() {

    try {

        let driveFiles = await google.drive("v3").files.list({
            auth: oauth,
            pageSize: PAGE_SIZE,
            fields: 'nextPageToken, files(name, id, webContentLink, parents)',
            q: "mimeType != 'application/vnd.google-apps.folder' and trashed=false and not mimeType contains 'application/vnd.google-apps'",
            supportsAllDrives: true,
            corpora: 'allDrives',
            includeItemsFromAllDrives: true
        });

        while (driveFiles.data.nextPageToken) {
            const { data: { files } } = driveFiles;

            for await (const file of files!) {
                console.log(`----- UPLOADING ${file.name}... ------`);
                await transfer({
                    file: {
                        id: file.id!,
                        name: file.name!,
                        webContentLink: file.webContentLink!,
                        parents: file.parents!
                    }
                });
                console.log(`------ ${file.name} UPLOADED -------`);
            }

            console.log('GETTING ANOTHER FILES....');
            driveFiles = await google.drive("v3").files.list({
                auth: oauth,
                pageSize: PAGE_SIZE,
                fields: 'nextPageToken, files(name, id, webContentLink, parents)',
                q: "mimeType != 'application/vnd.google-apps.folder' and trashed=false and not mimeType contains 'application/vnd.google-apps'",
                pageToken: driveFiles.data.nextPageToken,
                supportsAllDrives: true,
                corpora: 'allDrives',
                includeItemsFromAllDrives: true,
            });
        }

        console.log('ITS OVER...');

    } catch (error) {
        console.error(error);
    }

}

// Make sure only run this if the 
// file is run directly (not imported)
if (import.meta.main) {
    await ensureToken();
    await transferFiles();

    // await list();
    // await download('https://drive.google.com/uc?id=1IE-2yeNqnqKkpWZruzZJ-n6k7kfaWgao&export=download');
    // console.log(await getParentPath('1IE-2yeNqnqKkpWZruzZJ-n6k7kfaWgao'));
    // await getParentPath('0AAI4RCCtKABSUk9PVA');

    Deno.exit(0);
}

export default {
    ensureToken
}