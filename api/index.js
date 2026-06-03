export const runtime = "edge";

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/?api/, "") || "/";
  return new Response(JSON.stringify({ status: "ok", path }), {
    headers: { "Content-Type": "application/json" }
  });
}