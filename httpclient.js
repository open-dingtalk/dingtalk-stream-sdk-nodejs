"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpClient = exports.makeHttpRequest = void 0;
const http = require("http");
const https = require("https");
const url = require("url");
const util_1 = require("util");
const debug = (0, util_1.debuglog)('request-client');
const URL = url.URL;
const mimeMap = {
    text: 'application/text',
    json: 'application/json',
    octet: 'application/octet-stream',
};
async function makeHttpRequest(url, options = {}) {
    debug(`request '${url}'`);
    const whatwgUrl = new URL(url);
    const client = whatwgUrl.protocol === 'https:' ? https : http;
    const contentType = options.contentType;
    const dataType = options.dataType;
    const method = (options.method || 'GET').toUpperCase();
    const timeout = options.timeout || 5000;
    const headers = {
        Accept: mimeMap[dataType] || mimeMap.octet,
        ...options.headers,
    };
    let data;
    if (method === 'GET' && options.data) {
        for (const key of Object.keys(options.data)) {
            whatwgUrl.searchParams.set(key, options.data[key]);
        }
        headers['Content-Length'] = 0;
    }
    else if (options.data) {
        data = Buffer.from(JSON.stringify(options.data));
        headers['Content-Type'] = mimeMap[contentType] || mimeMap.octet;
        headers['Content-Length'] = data.byteLength;
    }
    return new Promise((resolve, reject) => {
        const req = client.request(whatwgUrl.toString(), {
            method,
            headers,
        }, res => {
            res.setTimeout(timeout, () => {
                res.destroy(new Error('Response Timeout'));
            });
            res.on('error', error => {
                reject(error);
            });
            const chunks = [];
            res.on('data', chunk => {
                chunks.push(chunk);
            });
            res.on('end', () => {
                let data = Buffer.concat(chunks);
                if (dataType === 'text' || dataType === 'json') {
                    data = data.toString('utf8');
                }
                if (dataType === 'json') {
                    try {
                        data = JSON.parse(data);
                    }
                    catch (e) {
                        return reject(new Error('[httpclient] Unable to parse response data'));
                    }
                }
                Object.assign(res, {
                    status: res.statusCode,
                    data,
                });
                debug(`request '${url}' resolved with status ${res.statusCode}`);
                resolve(res);
            });
        });
        req.setTimeout(timeout, () => {
            req.destroy(new Error('MidwayUtilHttpClientTimeoutError Request Timeout'));
        });
        req.on('error', error => {
            reject(error);
        });
        if (method !== 'GET') {
            req.end(data);
        }
        else {
            req.end();
        }
    });
}
exports.makeHttpRequest = makeHttpRequest;
/**
 * A simple http client
 */
class HttpClient {
    constructor(defaultOptions = {}) {
        this.defaultOptions = defaultOptions;
    }
    async request(url, options) {
        return makeHttpRequest(url, Object.assign(this.defaultOptions, options));
    }
}
exports.HttpClient = HttpClient;
//# sourceMappingURL=httpclient.js.map