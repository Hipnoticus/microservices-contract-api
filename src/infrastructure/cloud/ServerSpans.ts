import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * One SERVER span per HTTP request (2026-11-27).
 *
 * Under Bun the OpenTelemetry http instrumentation patches only the client side: the service recorded the calls it
 * made and never the requests it answered, so Grafana had no request rate, error rate or latency for it (the span
 * metrics in observability/zeus/otel-collector.yaml count SERVER spans). This middleware does what the instrumentation
 * does on Node: it continues the caller's trace (W3C traceparent), names the span after the matched route (no ids in
 * the name), records the status code and marks 5xx answers as errors. Health checks get no span.
 * Same file in ContractAPI, IssueAPI and HypnoticMaterialAPI.
 */
const SKIP = /^\/(actuator\/)?health(\/|$)|^\/(actuator|eureka)(\/|$)/i;

export function serverSpanMiddleware(tracerName = 'http-server') {
  const tracer = trace.getTracer(tracerName);
  return (req: any, res: any, next: (err?: unknown) => void): void => {
    const path = String(req.originalUrl || req.url || '/').split('?')[0];
    if (SKIP.test(path)) {
      next();
      return;
    }
    const parent = propagation.extract(context.active(), req.headers || {});
    const span = tracer.startSpan(String(req.method), {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': String(req.method), 'url.path': path },
    }, parent);
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      const status = Number(res.statusCode) || 0;
      const route = req.route && req.route.path ? String(req.baseUrl || '') + String(req.route.path) : '';
      if (route) {
        span.setAttribute('http.route', route);
        span.updateName(`${req.method} ${route}`);
      }
      span.setAttribute('http.response.status_code', status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    };
    res.on('finish', end);
    res.on('close', end);
    context.with(trace.setSpan(parent, span), () => next());
  };
}
