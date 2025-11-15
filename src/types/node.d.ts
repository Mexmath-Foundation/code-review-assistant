declare module 'fs' {
  export function readFileSync(path: string, options: { encoding: string } | string): string;
}

declare const process: {
  env: Record<string, string | undefined>;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
};

type FetchFunction = (input: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponse>;

declare const fetch: FetchFunction;
