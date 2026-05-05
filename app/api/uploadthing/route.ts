import { createRouteHandler, createUploadthing } from 'uploadthing/next';

const f = createUploadthing();

const fileRouter = {
  imageUploader: f({ image: { maxFileSize: '8MB', maxFileCount: 1 } })
    .middleware(() => ({ ok: true }))
    .onUploadComplete(({ file }) => {
      return { url: file.ufsUrl };
    }),
};

export type OurFileRouter = typeof fileRouter;

const handlers = createRouteHandler({ router: fileRouter });
export { handlers as GET, handlers as POST };