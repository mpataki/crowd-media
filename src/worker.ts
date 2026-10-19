export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
