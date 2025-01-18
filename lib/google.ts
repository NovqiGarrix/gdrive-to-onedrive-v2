// deno-lint-ignore-file no-unused-vars no-explicit-any
import { drive_v3, google } from "googleapis";
import env from "../config/env.ts";
import { REDIS_GOOGLE_TOKEN_KEY } from "../constant.ts";
import { MyError } from "../exceptions/MyError.ts";
import { googleTokenSchema } from "../schema.ts";
import { getRedisClient, oauth } from "../utils.ts";
import { MicrosoftAuthenticationProvider } from "./microsoft.ts";
import onedrive from "./onedrive.ts";
import { z } from "zod";
import { microsoftClient } from "./microsoft.ts";

const ROOT_FOLDER_NAME = 'novrianto254v2';

const drive = google.drive("v3");
// const oauth2 = getAPI('oauth')

const redis = await getRedisClient();
const microsoftAuth = new MicrosoftAuthenticationProvider(redis);

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

    const profile = await google.oauth2("v2")
        .userinfo.get({ auth: oauth });

    return profile.data;

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
const ONEDRIVE_GOOGLE_PHOTOS_PARENT_ID = '01COHAPYXCMKNQJWYFQJHLC3OIYAZX75UD';
const GOOGLE_DRIVE_PARENT_ID = '0AAI4RCCtKABSUk9PVA';

interface CheckIfFileExistsParams {
    filename: string;
    googleParentId?: string;
    oneDriveParentId?: string;
}

async function checkIfFileExists(params: CheckIfFileExistsParams) {

    const { filename, googleParentId, oneDriveParentId } = params;

    let parentPath: string | null = null;

    if (googleParentId) {
        parentPath = await getParent(googleParentId);
    }

    let parentId = oneDriveParentId ?? ONEDRIVE_PARENT_ID;

    if (parentPath) {
        // Find the id of the parent folder
        // https://graph.microsoft.com/v1.0/me/drive/root:/${ROOT_FOLDER_NAME}

        const resp = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${ROOT_FOLDER_NAME}/${parentPath}`, {
            headers: {
                Authorization: `Bearer ${await microsoftAuth.getAccessToken()}`,
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
            Authorization: `Bearer ${await microsoftAuth.getAccessToken()}`,
            'Content-Type': 'application/json'
        }
    });

    const data = await resp.json();

    if (!resp.ok) {
        throw new Error(data.error_description);
    }

    const { value }: { value: Array<{ name: string }> } = data;
    console.log(value);
    return value.some((v) => v.name === filename);

}

interface TransferParams {
    file: {
        id: string;
        name: string;
        webContentLink: string;
        parents: string[];
        permissions: drive_v3.Schema$File["permissions"];
    }
    deleteToo?: boolean;
    ownerEmail: string;
}

async function transfer(params: TransferParams) {

    const { file, deleteToo = false, ownerEmail } = params;

    const { id, name, webContentLink, parents, permissions } = file;
    const insideFolder = parents?.at(0) !== GOOGLE_DRIVE_PARENT_ID;
    const isOwned = !!(permissions && permissions.find((permission) => permission.role === "owner" && permission.emailAddress === ownerEmail));

    if (await checkIfFileExists({ filename: name, googleParentId: insideFolder ? parents?.at(0)! : undefined })) {
        console.log(`-------- ${name} ALREADY EXISTS --------`);

        if (deleteToo) {
            if (!isOwned) {
                return;
            }

            console.log(`-------- DELETING ${name} --------`);
            await drive.files.delete({
                auth: oauth,
                fileId: id,
            });
            console.log(`-------- ${name} DELETED --------`);
        }

        return;
    }

    const parentPath = await getParentPath(id);

    const res = await oauth.request({
        method: 'GET',
        url: webContentLink!,
        responseType: 'stream'
    });

    const g = await onedrive.items.uploadSimple({
        accessToken: await microsoftAuth.getAccessToken(),
        filename: name!,
        parentPath: `${ROOT_FOLDER_NAME}/${parentPath}`,
        readableStream: res.data
    });

    if (deleteToo) {
        if (!isOwned) {
            return;
        }

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

async function transferFiles(ownerEmail: string) {

    try {

        let driveFiles = await google.drive("v3").files.list({
            auth: oauth,
            pageSize: PAGE_SIZE,
            fields: 'nextPageToken, files(name, id, webContentLink, parents, permissions(emailAddress, role))',
            q: "trashed=false and not mimeType contains 'application/vnd.google-apps'",
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });

        let leftOver = driveFiles.data.files?.length!;

        while (driveFiles.data.nextPageToken || leftOver > 0) {
            const { data: { files } } = driveFiles;

            for await (const file of files!) {
                console.log(`----- UPLOADING ${file.name}... ------`);
                await transfer({
                    ownerEmail,
                    file: {
                        id: file.id!,
                        name: file.name!,
                        webContentLink: file.webContentLink!,
                        parents: file.parents!,
                        permissions: file.permissions!
                    },
                    deleteToo: env.DELETE_AFTER_TRANSFER,
                });
                console.log(`------ ${file.name} UPLOADED -------`);
            }

            leftOver = 0;

            if (driveFiles.data.nextPageToken) {
                console.log('GETTING ANOTHER FILES....');
                driveFiles = await google.drive("v3").files.list({
                    auth: oauth,
                    pageSize: PAGE_SIZE,
                    fields: 'nextPageToken, files(name, id, webContentLink, parents, permissions(type))',
                    q: "trashed=false and not mimeType contains 'application/vnd.google-apps'",
                    pageToken: driveFiles.data.nextPageToken!,
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                });

                console.log(driveFiles.data.files?.length);
                leftOver = driveFiles.data.files?.length!;
            }

        }

        // console.log({ i });

        console.log('ITS OVER...');

    } catch (error) {
        console.error(error);
    }

}

async function checkIfFileExistsV2(fullpath: string, uploadedFiles?: Array<UploadedFile>) {

    if (uploadedFiles) {
        if (uploadedFiles.some((file) => file.filepath === fullpath)) {
            return true;
        }
    }

    try {
        await microsoftClient.api(`/me/drive/root:/${ROOT_FOLDER_NAME}/${fullpath}`)
            .select('name')
            .get();

        return true;
    } catch (error: any) {
        if (error.statusCode === 404) {
            return false;
        }
        throw error;
    }

}

const mediaItemSchema = z.object({
    id: z.string(),
    filename: z.string(),
    baseUrl: z.string(),
    mediaMetadata: z.object({
        photo: z.object({}).optional(),
        video: z.object({}).optional()
    })
}).transform((data) => {
    const { mediaMetadata, ...res } = data;

    return {
        ...res,
        isPhoto: !!mediaMetadata.photo,
    }
});

const mediaItemsSchema = z.array(mediaItemSchema);

const googlePhotosMediaItemsResponseSchema = z.object({
    mediaItems: mediaItemsSchema,
    nextPageToken: z.string().optional()
});

interface UnUploadedFile {
    filepath: string;
    fileId: string;
    from: 'GooglePhotos' | 'GoogleDrive' | 'OneDrive'; // GooglePhotos or GoogleDrive or OneDrive
    error: any;
}

async function addUnUploadedFile(file: UnUploadedFile) {

    const existedFiles = new Set<UnUploadedFile>();

    try {
        const existedFilesArray = JSON.parse(await Deno.readTextFile('./unuploaded.json'));
        existedFilesArray.forEach((f: UnUploadedFile) => {
            existedFiles.add(f);
        });
    } catch (error) {
        console.error(error);
    }

    existedFiles.add(file);

    try {
        await Deno.writeTextFile('./unuploaded.json', JSON.stringify([...existedFiles], null, 2));
    } catch (error) {
        console.error(error);
        throw new Error('Failed to add unuploaded file');
    }

}

interface UploadedFile {
    filepath: string;
    fileId: string;
    from: 'GooglePhotos' | 'GoogleDrive' | 'OneDrive';
}

async function addUploadedFiles(files: Array<UploadedFile>) {

    const existedFiles = new Set<UploadedFile>();

    try {
        const existedFilesArray = JSON.parse(await Deno.readTextFile('./uploaded.json'));
        existedFilesArray.forEach((f: UploadedFile) => {
            existedFiles.add(f);
        });
    } catch (error) {
        console.error(error);
    }

    files.forEach((f) => {
        existedFiles.add(f);
    });

    try {
        await Deno.writeTextFile('./uploaded.json', JSON.stringify([...existedFiles], null, 2));
    } catch (error) {
        console.error(error);
        throw new Error('Failed to add uploaded file');
    }

}

async function getMediaItemFileSize(downloadUrl: string) {
    const resp = await fetch(downloadUrl, {
        method: 'HEAD',
        redirect: 'follow',
        headers: {
            Authorization: `Bearer ${oauth.credentials.access_token}`
        },
    });

    if (!resp.ok) {
        throw new Error('Failed to get file size');
    }

    const contentLength = resp.headers.get('content-length');
    if (!contentLength) {
        throw new Error('Failed to get content length');
    }

    return Number(contentLength);
}

async function transferFromGooglePhotos(_nextPageToken?: string) {

    const url = new URL('https://photoslibrary.googleapis.com/v1/mediaItems');
    url.searchParams.set('pageSize', '20');
    if (_nextPageToken) {
        url.searchParams.set('pageToken', _nextPageToken);
    }

    const filesResp = await fetch(url, {
        headers: {
            Authorization: `Bearer ${oauth.credentials.access_token}`,
            'Content-Type': 'application/json'
        }
    });

    if (!filesResp.ok) {
        throw new Error('Failed to get files');
    }

    const googlePhotosMediaItemsResponse = googlePhotosMediaItemsResponseSchema.parse(await filesResp.json());
    const { mediaItems, nextPageToken } = googlePhotosMediaItemsResponse;

    const uploadedFiles: Array<UploadedFile> = JSON.parse(await Deno.readTextFile('./uploaded.json'));

    const newUploadedFiles = (await Promise.all(
        mediaItems.map(async (item) => {
            try {
                // Check if the file is already uploaded
                if (await checkIfFileExistsV2(`Google Photos/${item.filename}`, uploadedFiles)) {
                    console.log(`------ ${item.filename} ALREADY EXISTS ------`);
                    return {
                        fileId: item.id,
                        from: 'GooglePhotos',
                        filepath: `Google Photos/${item.filename}`
                    }
                }

                console.log(`------ UPLOADING ${item.filename}... ------`);

                // The 'd' parameter is used to tell Google
                // that we want to download the file (not viewing it)
                const downloadUrl = `${item.baseUrl}=${item.isPhoto ? 'd' : 'dv'}`;
                // console.log(item.isPhoto, item.filename);

                const readableStream = await oauth.request({
                    method: 'GET',
                    url: downloadUrl,
                    responseType: 'stream',
                    retry: true,

                });

                const fileSize = await getMediaItemFileSize(downloadUrl);

                // If file size is less than 4MB, use simple upload
                if (fileSize < 4 * 1024 * 1024) {
                    await onedrive.items.uploadSimple({
                        readableStream: readableStream.data,
                        accessToken: await microsoftAuth.getAccessToken(),
                        filename: item.filename,
                        parentPath: `${ROOT_FOLDER_NAME}/Google Photos`,
                    });
                } else {
                    console.log(`--- File size: ${fileSize / 1024 / 1024} MB ---`.toUpperCase());
                    await onedrive.items.uploadSession({
                        readableStream: readableStream.data,
                        accessToken: await microsoftAuth.getAccessToken(),
                        filename: item.filename,
                        parentPath: `${ROOT_FOLDER_NAME}/Google Photos`,
                        fileSize,
                        chunksToUpload: 50,
                        conflictBehavior: 'replace'
                    }, (bytes) => {
                        console.log(`--- ${item.filename}: Uploaded ${bytes / (1024 * 1024)} MB ---`.toUpperCase());
                    });
                }

                console.log(`------ ${item.filename} UPLOADED ------`);

                return {
                    fileId: item.id,
                    from: 'GooglePhotos',
                    filepath: `Google Photos/${item.filename}`
                }
            } catch (error: any) {
                console.error(`Failed to upload ${item.filename}`, error);
                await addUnUploadedFile({
                    filepath: `Google Photos/${item.filename}`,
                    from: 'GooglePhotos',
                    fileId: item.id,
                    error: error?.message
                });
                console.error(error);
            }
        })
    )).filter(Boolean) as Array<UploadedFile>;

    await addUploadedFiles(newUploadedFiles);

    if (!nextPageToken) {
        return;
    }

    console.log(`------ GETTING ANOTHER FILES... ------`);
    return transferFromGooglePhotos(nextPageToken);

}

async function uploadUnUploadedFiles() {

    const unUploadedFiles: Array<UnUploadedFile> = JSON.parse(await Deno.readTextFile('./unuploaded.json'));

    for await (const file of unUploadedFiles) {

        const mediaItemResponse = await fetch(`https://photoslibrary.googleapis.com/v1/mediaItems/${file.fileId}`, {
            headers: {
                Authorization: `Bearer ${oauth.credentials.access_token}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await mediaItemResponse.json();

        if (!mediaItemResponse.ok) {
            console.error('Failed to get media item', data);
        }

        const { filename, baseUrl, isPhoto } = mediaItemSchema.parse(data);

        const downloadUrl = `${baseUrl}=${isPhoto ? 'd' : 'dv'}`;

        const fileSize = await getMediaItemFileSize(downloadUrl);

        const readableStream = await oauth.request({
            method: 'GET',
            url: downloadUrl,
            responseType: 'stream',
            retry: true,
        });

        console.log(`------ UPLOADING ${filename}... ------`);

        if (fileSize <= 4 * 1024 * 1024) {
            await onedrive.items.uploadSimple({
                readableStream: readableStream.data,
                accessToken: await microsoftAuth.getAccessToken(),
                filename,
                parentPath: `${ROOT_FOLDER_NAME}/Google Photos`,
            });
        } else {
            console.log(`--- File size: ${fileSize / 1024 / 1024} MB ---`.toUpperCase());
            await onedrive.items.uploadSession({
                readableStream: readableStream.data,
                accessToken: await microsoftAuth.getAccessToken(),
                filename,
                parentPath: `${ROOT_FOLDER_NAME}/Google Photos`,
                fileSize,
                chunksToUpload: 50,
                conflictBehavior: 'replace'
            }, (bytes) => {
                console.log(`--- ${filename}: Uploaded ${bytes / (1024 * 1024)} MB ---`.toUpperCase());
            });
        }

        console.log(`------ ${filename} UPLOADED ------`);

    }

}

// Make sure only run this if the 
// file is run directly (not imported)
if (import.meta.main) {
    const profile = await ensureToken();
    // await transferFiles(profile.email!);
    // await transferFromGooglePhotos();
    await uploadUnUploadedFiles();

    // await list();
    // await download('https://drive.google.com/uc?id=1IE-2yeNqnqKkpWZruzZJ-n6k7kfaWgao&export=download');
    // console.log(await getParentPath('1IE-2yeNqnqKkpWZruzZJ-n6k7kfaWgao'));
    // await getParentPath('0AAI4RCCtKABSUk9PVA');

    // Microsoft
    // await checkIfFileExistsV2('Google Photos/IMG_20240908_161729.jpgs');

    Deno.exit(0);
}

export default {
    ensureToken
}