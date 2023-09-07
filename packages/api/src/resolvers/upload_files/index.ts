/* eslint-disable @typescript-eslint/no-unused-vars */
import normalizeUrl from 'normalize-url'
import path from 'path'
import { createPage, getPageByParam, updatePage } from '../../elastic/pages'
import { PageType } from '../../elastic/types'
import { env } from '../../env'
import {
  ArticleSavingRequestStatus,
  MutationUploadFileRequestArgs,
  ResolverFn,
  UploadFileRequestErrorCode,
  UploadFileRequestResult,
  UploadFileStatus,
} from '../../generated/graphql'
import { validateUrl } from '../../services/create_page_save_request'
import { analytics } from '../../utils/analytics'
import { generateSlug } from '../../utils/helpers'
import {
  generateUploadFilePathName,
  generateUploadSignedUrl,
  getFilePublicUrl,
} from '../../utils/uploads'
import { WithDataSourcesContext } from '../types'

const isFileUrl = (url: string): boolean => {
  const parsedUrl = new URL(url)
  return parsedUrl.protocol == 'file:'
}

export const pageTypeForContentType = (contentType: string): PageType => {
  if (contentType == 'application/epub+zip') {
    return PageType.Book
  }
  return PageType.File
}

export const uploadFileRequestResolver: ResolverFn<
  UploadFileRequestResult,
  unknown,
  WithDataSourcesContext,
  MutationUploadFileRequestArgs
> = async (_obj, { input }, ctx) => {
  const { models, authTrx, claims, log } = ctx
  let uploadFileData: { id: string | null } = {
    id: null,
  }

  if (!claims?.uid) {
    return { errorCodes: [UploadFileRequestErrorCode.Unauthorized] }
  }

  analytics.capture({
    distinctId: claims.uid,
    event: 'file_upload_request',
    properties: {
      url: input.url,
      env: env.server.apiEnv,
    },
  })

  let title: string
  let fileName: string
  try {
    const url = normalizeUrl(new URL(input.url).href, {
      stripHash: true,
      stripWWW: false,
    })
    title = decodeURI(path.basename(new URL(url).pathname, '.pdf'))
    fileName = decodeURI(path.basename(new URL(url).pathname)).replace(
      /[^a-zA-Z0-9-_.]/g,
      ''
    )

    if (!fileName) {
      fileName = 'content.pdf'
    }

    if (!isFileUrl(url)) {
      try {
        validateUrl(url)
      } catch (error) {
        log.info('illegal file input url', error)
        return {
          errorCodes: [UploadFileRequestErrorCode.BadInput],
        }
      }
    }
  } catch {
    return { errorCodes: [UploadFileRequestErrorCode.BadInput] }
  }

  uploadFileData = await models.uploadFile.create({
    url: input.url,
    userId: claims.uid,
    fileName: fileName,
    status: UploadFileStatus.Initialized,
    contentType: input.contentType,
  })

  if (uploadFileData.id) {
    const uploadFileId = uploadFileData.id
    const uploadFilePathName = generateUploadFilePathName(
      uploadFileId,
      fileName
    )
    const uploadSignedUrl = await generateUploadSignedUrl(
      uploadFilePathName,
      input.contentType
    )

    const publicUrl = getFilePublicUrl(uploadFilePathName)

    // If this is a file URL, we swap in the GCS public URL
    if (isFileUrl(input.url)) {
      await authTrx(async (tx) => {
        await models.uploadFile.update(
          uploadFileId,
          {
            url: publicUrl,
            status: UploadFileStatus.Initialized,
          },
          tx
        )
      })
    }

    let createdPageId: string | undefined = undefined
    if (input.createPageEntry) {
      // If we have a file:// URL, don't try to match it
      // and create a copy of the page, just create a
      // new item.
      const page = isFileUrl(input.url)
        ? await getPageByParam({
            userId: claims.uid,
            url: input.url,
          })
        : undefined

      if (page) {
        if (
          !(await updatePage(
            page.id,
            {
              savedAt: new Date(),
              archivedAt: null,
            },
            ctx
          ))
        ) {
          return { errorCodes: [UploadFileRequestErrorCode.FailedCreate] }
        }
        createdPageId = page.id
      } else {
        const pageId = await createPage(
          {
            url: isFileUrl(input.url) ? publicUrl : input.url,
            id: input.clientRequestId || '',
            userId: claims.uid,
            title: title,
            hash: uploadFilePathName,
            content: '',
            pageType: pageTypeForContentType(input.contentType),
            uploadFileId: uploadFileData.id,
            slug: generateSlug(uploadFilePathName),
            createdAt: new Date(),
            savedAt: new Date(),
            readingProgressPercent: 0,
            readingProgressAnchorIndex: 0,
            state: ArticleSavingRequestStatus.Succeeded,
          },
          ctx
        )
        if (!pageId) {
          return { errorCodes: [UploadFileRequestErrorCode.FailedCreate] }
        }
        createdPageId = pageId
      }
    }

    return {
      id: uploadFileData.id,
      uploadSignedUrl,
      createdPageId: createdPageId,
    }
  } else {
    return { errorCodes: [UploadFileRequestErrorCode.FailedCreate] }
  }
}
