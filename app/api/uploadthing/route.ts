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

const { GET, POST } = createRouteHandler({ router: fileRouter });
export { GET, POST };