/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import crypto from 'crypto'
import normalizeUrl from 'normalize-url'
import path from 'path'
import _ from 'underscore'
import slugify from 'voca/slugify'
import wordsCounter from 'word-counting'
import { Highlight as HighlightData } from '../entity/highlight'
import { LibraryItem, LibraryItemState } from '../entity/library_item'
import { Recommendation as RecommendationData } from '../entity/recommendation'
import { RegistrationType, User } from '../entity/user'
import {
  Article,
  ArticleSavingRequest,
  ArticleSavingRequestStatus,
  ContentReader,
  CreateArticleError,
  CreateArticleSuccess,
  FeedArticle,
  Highlight,
  PageType,
  Profile,
  Recommendation,
  ResolverFn,
  SearchItem,
} from '../generated/graphql'
import { createPubSubClient } from '../pubsub'
import { redisClient } from '../redis'
import { Claims, WithDataSourcesContext } from '../resolvers/types'
import { validateUrl } from '../services/create_page_save_request'
import { updateLibraryItem } from '../services/library_item'
import { Merge } from '../util'
import { logger } from './logger'
interface InputObject {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export const TWEET_URL_REGEX =
  /twitter\.com\/(?:#!\/)?(\w+)\/status(?:es)?\/(\d+)(?:\/.*)?/

export const keysToCamelCase = (object: InputObject): InputObject => {
  Object.keys(object).forEach((key) => {
    const parts = key.split('_')
    if (parts.length <= 1) return

    const newKey =
      parts[0] +
      parts
        .slice(1)
        .map((p) => p[0].toUpperCase() + p.slice(1))
        .join('')
    delete Object.assign(object, { [newKey]: object[key] })[key]
  })
  return object
}

/**
 * Generates uuid using MD5 hash from the specified string
 * @param str - string to generate UUID from
 * @example
 * // returns "a3dcb4d2-29de-6fde-0db5-686dee47145d"
 * return uuidWithMd5('test')
 */
export const stringToHash = (str: string, convertToUUID = false): string => {
  const md5Hash = crypto.createHash('md5').update(str).digest('hex')
  if (!convertToUUID) return md5Hash
  return (
    md5Hash.substring(0, 8) +
    '-' +
    md5Hash.substring(8, 12) +
    '-' +
    md5Hash.substring(12, 16) +
    '-' +
    md5Hash.substring(16, 20) +
    '-' +
    md5Hash.substring(20)
  ).toLowerCase()
}

export function authorized<
  TSuccess,
  TError extends { errorCodes: string[] },
  /* eslint-disable @typescript-eslint/no-explicit-any */
  TArgs = any,
  TParent = any
  /* eslint-enable @typescript-eslint/no-explicit-any */
>(
  resolver: ResolverFn<
    TSuccess | TError,
    TParent,
    WithDataSourcesContext & { claims: Claims },
    TArgs
  >
): ResolverFn<TSuccess | TError, TParent, WithDataSourcesContext, TArgs> {
  return (parent, args, ctx, info) => {
    const { claims } = ctx
    if (claims?.uid) {
      return resolver(parent, args, { ...ctx, claims, uid: claims.uid }, info)
    }
    return { errorCodes: ['UNAUTHORIZED'] } as TError
  }
}

export const findDelimiter = (
  text: string,
  delimiters = ['\t', ',', ':', ';'],
  defaultDelimiter = '\t'
): string => {
  const textChunk = text
    // remove escaped sections that can contain false-positive delimiters
    .replace(/"(.|\n)*?"/gm, '')
    .split('\n')
    .slice(0, 5)
  const delimiter = delimiters.find((delimiter) =>
    textChunk.every(
      (row, _, array) =>
        row.split(delimiter).length === array[0].split(delimiter).length &&
        row.split(delimiter).length !== 1
    )
  )

  return delimiter || defaultDelimiter
}

// FIXME: Remove this Date stub after nullable types will be fixed
export const userDataToUser = (
  user: Merge<
    User,
    {
      isFriend?: boolean
      followersCount?: number
      friendsCount?: number
      sharedArticlesCount?: number
      sharedHighlightsCount?: number
      sharedNotesCount?: number
      viewerIsFollowing?: boolean
    }
  >
): {
  id: string
  name: string
  source: RegistrationType
  email?: string | null
  phone?: string | null
  picture?: string | null
  googleId?: string | null
  createdAt: Date
  isFriend?: boolean | null
  isFullUser: boolean
  viewerIsFollowing?: boolean | null
  sourceUserId: string
  friendsCount?: number
  followersCount?: number
  sharedArticles: FeedArticle[]
  sharedArticlesCount?: number
  sharedHighlightsCount?: number
  sharedNotesCount?: number
  profile: Profile
} => ({
  ...user,
  source: user.source as RegistrationType,
  createdAt: user.createdAt,
  friendsCount: user.friendsCount || 0,
  followersCount: user.followersCount || 0,
  isFullUser: true,
  viewerIsFollowing: user.viewerIsFollowing || user.isFriend || false,
  picture: user.profile.pictureUrl,
  sharedArticles: [],
  sharedArticlesCount: user.sharedArticlesCount || 0,
  sharedHighlightsCount: user.sharedHighlightsCount || 0,
  sharedNotesCount: user.sharedNotesCount || 0,
})

export const generateSlug = (title: string): string => {
  return slugify(title).substring(0, 64) + '-' + Date.now().toString(16)
}

export const MAX_CONTENT_LENGTH = 5e7 //50MB

export const errorHandler = async (
  result: CreateArticleError,
  userId: string,
  pageId?: string | null,
  pubsub = createPubSubClient()
): Promise<CreateArticleError | CreateArticleSuccess> => {
  if (!pageId) return result

  await updateLibraryItem(
    pageId,
    {
      state: LibraryItemState.Failed,
    },
    userId,
    pubsub
  )

  return result
}

export const highlightDataToHighlight = (
  highlight: HighlightData
): Highlight => ({
  ...highlight,
  createdByMe: false,
  reactions: [],
  replies: [],
  type: highlight.highlightType,
  user: userDataToUser(highlight.user),
})

export const recommandationDataToRecommendation = (
  recommendation: RecommendationData
): Recommendation => ({
  ...recommendation,
  user: {
    userId: recommendation.recommender.id,
    username: recommendation.recommender.profile.username,
    profileImageURL: recommendation.recommender.profile.pictureUrl,
    name: recommendation.recommender.name,
  },
  name: recommendation.group.name,
  recommendedAt: recommendation.createdAt,
})

export const libraryItemToArticleSavingRequest = (
  user: User,
  item: LibraryItem
): ArticleSavingRequest => ({
  ...item,
  user: userDataToUser(user),
  status: item.state as unknown as ArticleSavingRequestStatus,
  url: item.originalUrl,
  userId: user.id,
})

export const libraryItemToArticle = (item: LibraryItem): Article => ({
  ...item,
  url: item.originalUrl,
  state: item.state as unknown as ArticleSavingRequestStatus,
  content: item.readableContent,
  hash: item.textContentHash || '',
  isArchived: !!item.archivedAt,
  recommendations: item.recommendations?.map(
    recommandationDataToRecommendation
  ),
  image: item.thumbnail,
  contentReader: item.contentReader as unknown as ContentReader,
  readingProgressAnchorIndex: item.readingProgressHighestReadAnchor,
  readingProgressPercent: item.readingProgressBottomPercent,
  highlights: item.highlights?.map(highlightDataToHighlight) || [],
  uploadFileId: item.uploadFile?.id,
  pageType: item.itemType as unknown as PageType,
  wordsCount: item.wordCount,
})

export const libraryItemToSearchItem = (item: LibraryItem): SearchItem => ({
  ...item,
  url: item.originalUrl,
  state: item.state as unknown as ArticleSavingRequestStatus,
  content: item.readableContent,
  isArchived: !!item.archivedAt,
  pageType: item.itemType as unknown as PageType,
  readingProgressPercent: item.readingProgressBottomPercent,
  contentReader: item.contentReader as unknown as ContentReader,
  readingProgressAnchorIndex: item.readingProgressHighestReadAnchor,
  recommendations: item.recommendations?.map(
    recommandationDataToRecommendation
  ),
  image: item.thumbnail,
  highlights: item.highlights?.map(highlightDataToHighlight),
  wordsCount: item.wordCount,
})

export const isParsingTimeout = (libraryItem: LibraryItem): boolean => {
  return (
    // item processed more than 30 seconds ago
    libraryItem.state === LibraryItemState.Processing &&
    libraryItem.savedAt.getTime() < new Date().getTime() - 1000 * 30
  )
}

export const validatedDate = (
  date: Date | string | undefined
): Date | undefined => {
  try {
    if (typeof date === 'string') {
      // Sometimes readability returns a string for the date
      date = new Date(date)
    }

    if (!date) return undefined
    // Make sure the date year is not greater than 9999
    if (date.getFullYear() > 9999) {
      return undefined
    }
    return new Date(date)
  } catch (e) {
    logger.error('error validating date', { date, error: e })
    return undefined
  }
}

export const fileNameForFilePath = (urlStr: string): string => {
  const url = normalizeUrl(new URL(urlStr).href, {
    stripHash: true,
    stripWWW: false,
  })
  const fileName = decodeURI(path.basename(new URL(url).pathname)).replace(
    /[^a-zA-Z0-9-_.]/g,
    ''
  )
  return fileName
}

export const titleForFilePath = (url: string): string => {
  try {
    const title = decodeURI(path.basename(new URL(url).pathname, '.pdf'))
    return title
  } catch (e) {
    logger.error(e)
  }
  return url
}

export const validateUuid = (str: string): boolean => {
  const regexExp =
    /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/gi
  return regexExp.test(str)
}

export const isString = (check: any): check is string => {
  return typeof check === 'string' || check instanceof String
}

export const wait = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export const wordsCount = (text: string, isHtml = true): number => {
  try {
    return wordsCounter(text, { isHtml }).wordsCount
  } catch {
    return 0
  }
}

export const isBase64Image = (str: string): boolean => {
  return str.startsWith('data:image/')
}

export const generateRandomColor = (): string => {
  return (
    '#' +
    Math.floor(Math.random() * 16777215)
      .toString(16)
      .padStart(6, '0')
      .toUpperCase()
  )
}

export const unescapeHtml = (html: string): string => {
  return _.unescape(html)
}

export const isUrl = (str: string): boolean => {
  try {
    validateUrl(str)
    return true
  } catch {
    logger.info('not an url', { url: str })
    return false
  }
}

export const cleanUrl = (url: string) => {
  const trackingParams: (RegExp | string)[] = [/^utm_\w+/i] // remove utm tracking parameters
  if (TWEET_URL_REGEX.test(url)) {
    // remove tracking parameters from tweet links:
    // https://twitter.com/omnivore/status/1673218959624093698?s=12&t=R91quPajs0E53Yds-fhv2g
    trackingParams.push('s', 't')
  }
  return normalizeUrl(url, {
    stripHash: true,
    stripWWW: false,
    removeQueryParameters: trackingParams,
    removeTrailingSlash: false,
  })
}

export const deepDelete = <T, K extends keyof T>(obj: T, keys: K[]) => {
  // make a copy of the object
  const copy = { ...obj }

  keys.forEach((key) => {
    delete copy[key]
  })

  return copy as Omit<T, K>
}

export const isRelativeUrl = (url: string): boolean => {
  return url.startsWith('/')
}

export const getAbsoluteUrl = (url: string, baseUrl: string): string => {
  return new URL(url, baseUrl).href
}

export const setRecentlySavedItemInRedis = async (
  userId: string,
  url: string
) => {
  // save the url in redis for 8 hours so rss-feeder won't try to re-save it
  const redisKey = `recent-saved-item:${userId}:${url}`
  const ttlInSeconds = 60 * 60 * 8
  try {
    return redisClient.set(redisKey, 1, {
      EX: ttlInSeconds,
      NX: true,
    })
  } catch (error) {
    logger.error('error setting recently saved item in redis', {
      redisKey,
      error,
    })
  }
}
