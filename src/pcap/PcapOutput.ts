/**
 * Parsers for capinfos text output and tshark JSON fields output.
 *
 * Both tools are stable CLIs from the Wireshark suite; the parsers below
 * keep the exact producer lines and preserve unrecognized content rather
 * than dropping it silently.
 */

export interface CapinfosMetadata {
  readonly fileType: string | null;
  readonly encapsulation: string | null;
  readonly packetCount: number | null;
  readonly captureStart: string | null;
  readonly captureEnd: string | null;
  readonly captureDurationSeconds: number | null;
  readonly snapshotLength: number | null;
  readonly sha256: string | null;
}

const capinfosLine = (text: string, prefix: string): string | null => {
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
};

/** Project capinfos text output into its bounded metadata fields. */
export const parseCapinfosOutput = (stdout: string): CapinfosMetadata => {
  const durationText = capinfosLine(stdout, "Capture duration:");
  const duration =
    durationText === null
      ? null
      : Number(durationText.replace(/[^0-9.]/gu, ""));
  return {
    fileType: capinfosLine(stdout, "File type:"),
    encapsulation: capinfosLine(stdout, "File encapsulation:"),
    packetCount: (() => {
      const text = capinfosLine(stdout, "Number of packets:");
      const parsed = text === null ? null : /^(\d+)/u.exec(text);
      return parsed === null ? null : Number(parsed[1]!);
    })(),
    captureStart: capinfosLine(stdout, "Earliest packet time:"),
    captureEnd: capinfosLine(stdout, "Latest packet time:"),
    captureDurationSeconds:
      duration !== null && Number.isFinite(duration) ? duration : null,
    snapshotLength: (() => {
      const text = capinfosLine(stdout, "Packet size limit:");
      const parsed = text === null ? null : /(\d+)/u.exec(text);
      return parsed === null ? null : Number(parsed[1]!);
    })(),
    sha256: capinfosLine(stdout, "SHA256:"),
  };
};

export interface EndpointEntry {
  readonly address: string;
  readonly port: number | null;
  readonly packetCount: number;
}

export interface DnsEntry {
  readonly query: string;
  readonly responseAddresses: string[];
}

export interface ProtocolEntry {
  readonly protocol: string;
  readonly packetCount: number;
}

export interface TsharkFields {
  readonly endpoints: EndpointEntry[];
  readonly endpointCount: number;
  readonly dnsQueries: DnsEntry[];
  readonly dnsQueryCount: number;
  readonly tlsSniValues: string[];
  readonly protocolDistribution: ProtocolEntry[];
  readonly httpRequestUris: string[];
  readonly httpRequestUriCount: number;
}

interface TsharkJsonLayer {
  readonly [key: string]: string[] | undefined;
}

const layerField = (
  layers: TsharkJsonLayer | undefined,
  key: string,
): string[] => {
  const value = layers?.[key];
  return Array.isArray(value) ? value : [];
};

/**
 * Project tshark's `-T json -e ...` output into the bounded result fields.
 * The JSON structure is an array of `{_source: {layers: {...}}}` objects.
 */
export const parseTsharkJsonOutput = (
  stdout: string,
  limits: {
    readonly maxEndpoints: number;
    readonly maxDnsQueries: number;
    readonly maxSniValues: number;
    readonly maxProtocols: number;
    readonly maxHttpUris: number;
  },
): TsharkFields => {
  let packets: { _source?: { layers?: TsharkJsonLayer } }[] = [];
  try {
    packets = JSON.parse(stdout) as {
      _source?: { layers?: TsharkJsonLayer };
    }[];
  } catch {
    // An empty or malformed stream yields empty projections, not a crash.
  }

  const endpointMap = new Map<string, EndpointEntry>();
  const dnsMap = new Map<string, DnsEntry>();
  const sniSet = new Set<string>();
  const protocolMap = new Map<string, number>();
  const uriSet = new Set<string>();

  for (const packet of packets) {
    const layers = packet._source?.layers;
    if (layers === undefined) continue;

    for (const src of layerField(layers, "ip.src")) {
      const key = src;
      const existing = endpointMap.get(key);
      endpointMap.set(key, {
        address: src,
        port: null,
        packetCount: (existing?.packetCount ?? 0) + 1,
      });
    }
    for (const dst of layerField(layers, "ip.dst")) {
      const existing = endpointMap.get(dst);
      endpointMap.set(dst, {
        address: dst,
        port: null,
        packetCount: (existing?.packetCount ?? 0) + 1,
      });
    }

    for (const query of layerField(layers, "dns.qry.name")) {
      if (!dnsMap.has(query))
        dnsMap.set(query, { query, responseAddresses: [] });
    }
    for (const response of layerField(layers, "dns.a")) {
      // Associate responses with the most recent query (approximation).
      const last = [...dnsMap.keys()].pop();
      if (last !== undefined) {
        const entry = dnsMap.get(last)!;
        if (!entry.responseAddresses.includes(response))
          entry.responseAddresses.push(response);
      }
    }
    for (const response of layerField(layers, "dns.aaaa")) {
      const last = [...dnsMap.keys()].pop();
      if (last !== undefined) {
        const entry = dnsMap.get(last)!;
        if (!entry.responseAddresses.includes(response))
          entry.responseAddresses.push(response);
      }
    }

    for (const sni of layerField(
      layers,
      "tls.handshake.extensions_server_name",
    ))
      sniSet.add(sni);

    for (const protocol of layerField(layers, "frame.protocols"))
      protocolMap.set(protocol, (protocolMap.get(protocol) ?? 0) + 1);

    for (const uri of layerField(layers, "http.request.full_uri"))
      uriSet.add(uri);
  }

  const endpoints = [...endpointMap.values()]
    .sort((a, b) => b.packetCount - a.packetCount)
    .slice(0, limits.maxEndpoints);
  const dnsQueries = [...dnsMap.values()].slice(0, limits.maxDnsQueries);
  const tlsSniValues = [...sniSet].slice(0, limits.maxSniValues);
  const protocolDistribution = [...protocolMap.entries()]
    .map(([protocol, packetCount]) => ({ protocol, packetCount }))
    .sort((a, b) => b.packetCount - a.packetCount)
    .slice(0, limits.maxProtocols);
  const httpRequestUris = [...uriSet].slice(0, limits.maxHttpUris);

  return {
    endpoints,
    endpointCount: endpointMap.size,
    dnsQueries,
    dnsQueryCount: dnsMap.size,
    tlsSniValues,
    protocolDistribution,
    httpRequestUris,
    httpRequestUriCount: uriSet.size,
  };
};
