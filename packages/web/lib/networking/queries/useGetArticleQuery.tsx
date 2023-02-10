import { gql } from 'graphql-request'
import useSWRImmutable, { Cache } from 'swr'
import { makeGqlFetcher, RequestContext, ssrFetcher } from '../networkHelpers'
import {
  articleFragment,
  ContentReader,
  State,
} from '../fragments/articleFragment'
import { Highlight, highlightFragment } from '../fragments/highlightFragment'
import { ScopedMutator } from 'swr/dist/types'
import { Label, labelFragment } from '../fragments/labelFragment'
import {
  LibraryItems,
  Recommendation,
  recommendationFragment,
} from './useGetLibraryItemsQuery'

export type ArticleFormat = 'html' | 'distiller'

type ArticleQueryInput = {
  username?: string
  slug?: string
  format?: ArticleFormat
  includeFriendsHighlights?: boolean
}

type ArticleQueryOutput = {
  articleData?: ArticleData
  isLoading: boolean
  articleFetchError: string[] | null
}

type ArticleData = {
  article: NestedArticleData
}

type NestedArticleData = {
  article: ArticleAttributes
  errorCodes?: string[]
}

export type ArticleAttributes = {
  id: string
  title: string
  url: string
  originalArticleUrl: string
  author?: string
  image?: string
  savedAt: string
  isArchived: boolean
  createdAt: string
  publishedAt?: string
  description?: string
  contentReader: ContentReader
  readingProgressPercent: number
  readingProgressAnchorIndex: number
  slug: string
  savedByViewer?: boolean
  content: string
  highlights: Highlight[]
  linkId: string
  labels?: Label[]
  state?: State
  recommendations?: Recommendation[]
}

const query = gql`
  query GetArticle(
    $username: String!
    $slug: String!
    $includeFriendsHighlights: Boolean
  ) {
    article(username: $username, slug: $slug) {
      ... on ArticleSuccess {
        article {
          ...ArticleFields
          content
          highlights(input: { includeFriends: $includeFriendsHighlights }) {
            ...HighlightFields
          }
          labels {
            ...LabelFields
          }
          recommendations {
            ...RecommendationFields
          }
        }
      }
      ... on ArticleError {
        errorCodes
      }
    }
  }
  ${articleFragment}
  ${highlightFragment}
  ${labelFragment}
  ${recommendationFragment}
`

export function useGetArticleQuery({
  username,
  slug,
  includeFriendsHighlights,
}: ArticleQueryInput): ArticleQueryOutput {
  const variables = {
    username,
    slug,
    includeFriendsHighlights,
  }

  const { data, error, mutate } = useSWRImmutable(
    slug ? [query, username, slug, includeFriendsHighlights] : null,
    makeGqlFetcher(variables)
  )

  let resultData: ArticleData | undefined = data as ArticleData
  let resultError = error
  // We need to check the response errors here and return the error
  // it will be nested in the data pages, if there is one error,
  // we invalidate the data and return the error. We also zero out
  // the response in the case of an error.
  if (!error && resultData && resultData.article.errorCodes) {
    resultError = resultData.article.errorCodes
    resultData = undefined
  }

  return {
    articleData: resultData,
    isLoading: !error && !data,
    articleFetchError: resultError ? (resultError as string[]) : null,
  }
}

export async function articleQuery(
  context: RequestContext,
  input: ArticleQueryInput
): Promise<ArticleAttributes> {
  const result = (await ssrFetcher(context, query, input)) as ArticleData
  if (result.article) {
    return result.article.article
  }

  return Promise.reject()
}

export const cacheArticle = (
  mutate: ScopedMutator,
  username: string,
  article: ArticleAttributes,
  includeFriendsHighlights = false
) => {
  mutate([query, username, article.slug, includeFriendsHighlights], {
    article: { article: { ...article, cached: true } },
  })
}

export const removeItemFromCache = (
  cache: Cache<unknown>,
  mutate: ScopedMutator,
  itemId: string
) => {
  try {
    const mappedCache = cache as Map<string, unknown>
    mappedCache.forEach((value: any, key) => {
      if (typeof value == 'object' && 'search' in value) {
        const search = value.search as LibraryItems
        const idx = search.edges.findIndex((edge) => edge.node.id == itemId)
        if (idx > -1) {
          value.search.edges.splice(idx, 1)
          mutate(key, value, false)
        }
      }
    })

    mappedCache.forEach((value: any, key) => {
      if (Array.isArray(value)) {
        const idx = value.findIndex((item) => 'search' in item)
        if (idx > -1) {
          mutate(key, value, false)
        }
      }
    })
  } catch (error) {
    console.log('error removing item from cache', error)
  }
}
