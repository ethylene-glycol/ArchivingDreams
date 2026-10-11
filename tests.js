const fs = require("node:fs");
const http2 = require("node:http2");
const path = require("node:path");

const ORIGIN = `https://prod.puprod.indreams.me`;
const TIMEOUT_AFTER = 10_000;

function formatDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function summarizeRun(summary) {
  const summaryDir = path.join(__dirname, "summaries");
  fs.mkdirSync(summaryDir, { recursive: true });
  const summaryPath = path.join(
    summaryDir,
    `${formatDate(new Date(summary.startedAt))}.txt`,
  );
  const lines = [
    "Dreams API route test summary",
    `Origin: ${summary.origin}`,
    `Started: ${summary.startedAt}`,
    `Completed: ${summary.completedAt}`,
    `Total routes: ${summary.counts.total}`,
    `Reached: ${summary.counts.reached}`,
    `Failed: ${summary.counts.failed}`,
    `Not run: ${summary.counts.notRun}`,
  ];

  if (summary.connectionError) {
    lines.push(`error: ${summary.connectionError}`);
  }

  lines.push("", "route results:");
  for (const result of summary.results) {
    const details =
      result.status === "reached"
        ? `HTTP ${result.httpStatus}, gRPC ${result.grpcStatus}, ${result.responseBytes} response bytes`
        : result.error || "no result details";
    lines.push(
      `[${result.status.toUpperCase()}] ${result.service}: ${result.method} — ${details}`,
    );
  }

  fs.writeFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`wrote summary to ${summaryPath}`);
}

function readRoutes() {
  const routesPath = path.join(__dirname, "routes.json");
  const services = JSON.parse(fs.readFileSync(routesPath, "utf8"));
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error(`${routesPath} must contain a non-empty array of services`);
  }

  const routes = [];
  for (const service of services) {
    if (
      typeof service.name !== "string" ||
      !Array.isArray(service.methods) ||
      service.methods.length === 0
    ) {
      throw new Error(
        `invalid service entry in ${routesPath}: ${JSON.stringify(service)}`,
      );
    }

    for (const method of service.methods) {
      if (typeof method !== "string" || !/^[A-Za-z0-9]+$/.test(method)) {
        throw new Error(
          `invalid method in ${service.name}: ${JSON.stringify(method)}`,
        );
      }
      routes.push({
        service: service.name,
        method,
        rpcPath: `/puserver.v1.${service.name}/${method}`,
      });
    }
  }

  return routes;
}

function testRoute(session, { rpcPath, service, method }) {
  return new Promise((resolve) => {
    let responseBytes = 0;
    let settled = false;
    const stream = session.request({
      ":method": "POST",
      ":path": rpcPath,
      "content-type": "application/grpc",
      te: "trailers",
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ service, method, rpcPath, ...result });
    };

    stream.setTimeout(TIMEOUT_AFTER, () => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      finish({ ok: false, error: `timed out after ${TIMEOUT_AFTER} ms` });
    });

    stream.on("response", (headers) => {
      stream.responseHeaders = headers;
    });
    stream.on("trailers", (trailers) => {
      stream.grpcStatus = trailers["grpc-status"];
    });
    stream.on("data", (chunk) => {
      responseBytes += chunk.length;
    });
    stream.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });
    stream.on("end", () => {
      const headers = stream.responseHeaders || {};
      finish({
        ok: true,
        httpStatus: headers[":status"],
        grpcStatus: stream.grpcStatus ?? headers["grpc-status"] ?? "not provided",
        responseBytes,
      });
    });

    stream.end(Buffer.from([0, 0, 0, 0, 0]));
  });
}

async function main() {
  const routes = readRoutes();
  const summary = {
    origin: ORIGIN,
    startedAt: new Date().toISOString(),
    completedAt: null,
    routes,
    results: [],
    connectionError: null,
  };

  console.log(`found ${routes.length} routes`);

  const session = http2.connect(ORIGIN);
  try {
    try {
      await new Promise((resolve, reject) => {
        session.once("connect", resolve);
        session.once("error", reject);
        const timer = setTimeout(
          () => reject(new Error(`HTTP/2 connection timed out after ${TIMEOUT_AFTER} ms`)),
          TIMEOUT_AFTER,
        );
        session.once("connect", () => clearTimeout(timer));
        session.once("error", () => clearTimeout(timer));
      });
    } catch (error) {
      summary.connectionError = error.message;
      summary.results = routes.map((route) => ({
        ...route,
        status: "not_run",
        error: `connection failed: ${error.message}`,
      }));
      console.error(`connection failed: ${error.message}`);
    }

    if (!summary.connectionError) {
      for (const route of routes) {
        try {
          const result = await testRoute(session, route);
          summary.results.push({
            ...result,
            status: result.ok ? "reached" : "failed",
          });
          if (result.ok) {
            console.log(
              `[REACHED] ${result.service}: ${result.method} - HTTP ${result.httpStatus}, gRPC ${result.grpcStatus}, ${result.responseBytes} response bytes`,
            );
          } else {
            console.log(
              `[FAILED] ${result.service}: ${result.method} - ${result.error}`,
            );
          }
        } catch (error) {
          summary.results.push({
            ...route,
            status: "failed",
            error: error.message,
          });
          console.log(
            `[FAILED] ${route.service}: ${route.method} - ${error.message}`,
          );
        }
      }
    }

    const reached = summary.results.filter(
      ({ status }) => status === "reached",
    ).length;
    const failed = summary.results.filter(
      ({ status }) => status === "failed",
    ).length;
    const notRun = summary.results.filter(
      ({ status }) => status === "not_run",
    ).length;
    summary.completedAt = new Date().toISOString();
    summary.counts = {
      total: routes.length,
      reached,
      failed,
      notRun,
    };

    console.log(
      `summary: ${reached} reached, ${failed} failed, ${notRun} not run, ${routes.length} total.`,
    );
    summarizeRun(summary);
    if (failed > 0 || notRun > 0) process.exitCode = 1;
  } finally {
    session.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`test run failed: ${error.message}`);
    process.exitCode = 1;
  });
}
