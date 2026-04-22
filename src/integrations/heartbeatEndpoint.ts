import * as https from 'https';
import * as vscode from 'vscode';
import { Heartbeat } from '../storage';

const ENDPOINT_CONFIG_KEY = 'heartbeatEndpointConfig';
const BEARER_TOKEN_SECRET_KEY = 'heartbeatEndpointBearerToken';
const REQUEST_TIMEOUT_MS = 8000;

interface StoredHeartbeatEndpointConfig {
    endpointUrl: string;
    enabled: boolean;
}

export interface HeartbeatEndpointConfig {
    endpointUrl: string;
    enabled: boolean;
    hasBearerToken: boolean;
}

interface HeartbeatForwardPayload {
    type: 'heartbeat';
    sentAt: string;
    heartbeat: Heartbeat;
}

interface HeartbeatForwardTestPayload {
    type: 'test';
    sentAt: string;
}

function validateEndpointUrl(endpointUrl: string): string {
    const url = new URL(endpointUrl);
    if (url.protocol !== 'https:') {
        throw new Error('Endpoint must use https://');
    }
    return url.toString();
}

async function getStoredConfig(context: vscode.ExtensionContext): Promise<StoredHeartbeatEndpointConfig> {
    const stored = context.globalState.get<StoredHeartbeatEndpointConfig>(ENDPOINT_CONFIG_KEY);
    return {
        endpointUrl: stored?.endpointUrl ?? '',
        enabled: stored?.enabled ?? false
    };
}

async function postJson(urlString: string, token: string, payload: HeartbeatForwardPayload | HeartbeatForwardTestPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const url = new URL(urlString);

    await new Promise<void>((resolve, reject) => {
        const request = https.request(
            {
                method: 'POST',
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port ? Number(url.port) : undefined,
                path: `${url.pathname}${url.search}`,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: REQUEST_TIMEOUT_MS
            },
            (response) => {
                let responseBody = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    responseBody += chunk;
                });
                response.on('end', () => {
                    const statusCode = response.statusCode ?? 0;
                    if (statusCode >= 200 && statusCode < 300) {
                        resolve();
                        return;
                    }
                    reject(new Error(`Endpoint returned HTTP ${statusCode}${responseBody ? `: ${responseBody}` : ''}`));
                });
            }
        );

        request.on('error', (error) => {
            reject(error);
        });

        request.on('timeout', () => {
            request.destroy(new Error('Request timed out'));
        });

        request.write(body);
        request.end();
    });
}

export async function getHeartbeatEndpointConfig(context: vscode.ExtensionContext): Promise<HeartbeatEndpointConfig> {
    const [stored, token] = await Promise.all([
        getStoredConfig(context),
        context.secrets.get(BEARER_TOKEN_SECRET_KEY)
    ]);

    return {
        endpointUrl: stored.endpointUrl,
        enabled: stored.enabled,
        hasBearerToken: !!token
    };
}

export async function saveHeartbeatEndpointConfig(
    context: vscode.ExtensionContext,
    input: { endpointUrl: string; enabled: boolean; updateBearerToken: boolean; bearerToken: string }
): Promise<HeartbeatEndpointConfig> {
    const endpointUrl = input.endpointUrl.trim();
    if (!endpointUrl) {
        throw new Error('Endpoint URL is required');
    }
    const normalizedEndpointUrl = validateEndpointUrl(endpointUrl);

    const existingToken = await context.secrets.get(BEARER_TOKEN_SECRET_KEY);
    let hasBearerToken = !!existingToken;

    if (input.updateBearerToken) {
        const token = input.bearerToken.trim();
        if (!token) {
            throw new Error('Bearer token cannot be empty when updating');
        }
        await context.secrets.store(BEARER_TOKEN_SECRET_KEY, token);
        hasBearerToken = true;
    }

    if (input.enabled && !hasBearerToken) {
        throw new Error('Set a bearer token before enabling endpoint posting');
    }

    await context.globalState.update(ENDPOINT_CONFIG_KEY, {
        endpointUrl: normalizedEndpointUrl,
        enabled: input.enabled
    } satisfies StoredHeartbeatEndpointConfig);

    return getHeartbeatEndpointConfig(context);
}

export async function clearHeartbeatEndpointToken(context: vscode.ExtensionContext): Promise<HeartbeatEndpointConfig> {
    await context.secrets.delete(BEARER_TOKEN_SECRET_KEY);
    const stored = await getStoredConfig(context);
    if (stored.enabled) {
        await context.globalState.update(ENDPOINT_CONFIG_KEY, {
            endpointUrl: stored.endpointUrl,
            enabled: false
        } satisfies StoredHeartbeatEndpointConfig);
    }
    return getHeartbeatEndpointConfig(context);
}

export async function sendHeartbeatToConfiguredEndpoint(
    context: vscode.ExtensionContext,
    heartbeat: Heartbeat,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const [stored, token] = await Promise.all([
        getStoredConfig(context),
        context.secrets.get(BEARER_TOKEN_SECRET_KEY)
    ]);

    if (!stored.enabled || !stored.endpointUrl || !token) {
        return;
    }

    const payload: HeartbeatForwardPayload = {
        type: 'heartbeat',
        sentAt: new Date().toISOString(),
        heartbeat
    };

    try {
        await postJson(stored.endpointUrl, token, payload);
    } catch (error) {
        outputChannel.appendLine(`[endpoint] heartbeat forward failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function testConfiguredHeartbeatEndpoint(context: vscode.ExtensionContext): Promise<void> {
    const [stored, token] = await Promise.all([
        getStoredConfig(context),
        context.secrets.get(BEARER_TOKEN_SECRET_KEY)
    ]);

    if (!stored.endpointUrl) {
        throw new Error('Endpoint URL is not configured');
    }
    if (!token) {
        throw new Error('Bearer token is not configured');
    }

    const payload: HeartbeatForwardTestPayload = {
        type: 'test',
        sentAt: new Date().toISOString()
    };

    await postJson(stored.endpointUrl, token, payload);
}
