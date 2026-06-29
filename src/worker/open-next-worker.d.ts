declare module "*/.open-next/worker.js" {
  const worker: Required<Pick<ExportedHandler<Cloudflare.Env>, "fetch">>;
  export default worker;
}
