import * as jwt from 'jsonwebtoken'
import {
  RegistrationType,
  StatusType,
  User as UserEntity,
} from '../../entity/user'
import { env } from '../../env'
import {
  DeleteAccountError,
  DeleteAccountErrorCode,
  DeleteAccountSuccess,
  GoogleSignupResult,
  LoginErrorCode,
  LoginResult,
  LogOutErrorCode,
  LogOutResult,
  MutationDeleteAccountArgs,
  MutationGoogleLoginArgs,
  MutationGoogleSignupArgs,
  MutationUpdateEmailArgs,
  MutationUpdateUserArgs,
  MutationUpdateUserProfileArgs,
  QueryUserArgs,
  QueryValidateUsernameArgs,
  ResolverFn,
  SignupErrorCode,
  UpdateEmailError,
  UpdateEmailErrorCode,
  UpdateEmailSuccess,
  UpdateUserError,
  UpdateUserErrorCode,
  UpdateUserProfileError,
  UpdateUserProfileErrorCode,
  UpdateUserProfileSuccess,
  UpdateUserSuccess,
  User,
  UserErrorCode,
  UserResult,
  UsersError,
  UsersSuccess,
} from '../../generated/graphql'
import { userRepository } from '../../repository/user'
import { createUser } from '../../services/create_user'
import { sendVerificationEmail } from '../../services/send_emails'
import { softDeleteUser } from '../../services/user'
import { authorized, userDataToUser } from '../../utils/helpers'
import { validateUsername } from '../../utils/usernamePolicy'
import { WithDataSourcesContext } from '../types'

export const updateUserResolver = authorized<
  UpdateUserSuccess,
  UpdateUserError,
  MutationUpdateUserArgs
>(async (_, { input: { name, bio } }, { uid, authTrx }) => {
  const user = await userRepository.findById(uid)
  if (!user) {
    return { errorCodes: [UpdateUserErrorCode.UserNotFound] }
  }

  const errorCodes = []

  if (!name) {
    errorCodes.push(UpdateUserErrorCode.EmptyName)
  }

  if (bio && bio.length > 400) {
    errorCodes.push(UpdateUserErrorCode.BioTooLong)
  }

  if (errorCodes.length > 0) {
    return { errorCodes }
  }

  const updatedUser = await authTrx((tx) =>
    tx.getRepository(UserEntity).save({
      ...user,
      name,
      profile: {
        ...user.profile,
        bio,
      },
    })
  )

  return { user: userDataToUser(updatedUser) }
})

export const updateUserProfileResolver = authorized<
  UpdateUserProfileSuccess,
  UpdateUserProfileError,
  MutationUpdateUserProfileArgs
>(async (_, { input: { userId, username, pictureUrl } }, { uid, authTrx }) => {
  const user = await userRepository.findById(userId)
  if (!user) {
    return { errorCodes: [UpdateUserProfileErrorCode.Unauthorized] }
  }

  if (user.id !== uid) {
    return {
      errorCodes: [UpdateUserProfileErrorCode.Forbidden],
    }
  }

  if (!(username || pictureUrl)) {
    return {
      errorCodes: [UpdateUserProfileErrorCode.BadData],
    }
  }

  const lowerCasedUsername = username?.toLowerCase()
  if (lowerCasedUsername) {
    const existingUser = await userRepository.findOneBy({
      profile: {
        username: lowerCasedUsername,
      },
      status: StatusType.Active,
    })
    if (existingUser?.id) {
      return {
        errorCodes: [UpdateUserProfileErrorCode.UsernameExists],
      }
    }

    if (!validateUsername(lowerCasedUsername)) {
      return {
        errorCodes: [UpdateUserProfileErrorCode.BadUsername],
      }
    }
  }

  const updatedUser = await authTrx((tx) =>
    tx.getRepository(UserEntity).save({
      ...user,
      profile: {
        ...user.profile,
        username: lowerCasedUsername,
        pictureUrl,
      },
    })
  )

  return { user: userDataToUser(updatedUser) }
})

export const googleLoginResolver: ResolverFn<
  LoginResult,
  unknown,
  WithDataSourcesContext,
  MutationGoogleLoginArgs
> = async (_obj, { input }, { setAuth }) => {
  const { email, secret } = input

  try {
    jwt.verify(secret, env.server.jwtSecret)
  } catch {
    return { errorCodes: [LoginErrorCode.AuthFailed] }
  }

  const user = await userRepository.findOneBy({
    email,
    status: StatusType.Active,
  })
  if (!user?.id) {
    return { errorCodes: [LoginErrorCode.UserNotFound] }
  }

  // set auth cookie in response header
  await setAuth({ uid: user.id })
  return { me: userDataToUser(user) }
}

export const validateUsernameResolver: ResolverFn<
  boolean,
  Record<string, unknown>,
  WithDataSourcesContext,
  QueryValidateUsernameArgs
> = async (_obj, { username }) => {
  const lowerCasedUsername = username.toLowerCase()
  if (!validateUsername(lowerCasedUsername)) {
    return false
  }

  const user = await userRepository.findOneBy({
    profile: {
      username: lowerCasedUsername,
    },
  })
  return !user
}

export const googleSignupResolver: ResolverFn<
  GoogleSignupResult,
  Record<string, unknown>,
  WithDataSourcesContext,
  MutationGoogleSignupArgs
> = async (_obj, { input }, { setAuth, log }) => {
  const { email, username, name, bio, sourceUserId, pictureUrl, secret } = input
  const lowerCasedUsername = username.toLowerCase()

  try {
    jwt.verify(secret, env.server.jwtSecret)
  } catch {
    return { errorCodes: [SignupErrorCode.ExpiredToken] }
  }

  try {
    const [user, profile] = await createUser({
      email,
      sourceUserId,
      provider: 'GOOGLE',
      name,
      username: lowerCasedUsername,
      pictureUrl: pictureUrl,
      bio: bio || undefined,
      inviteCode: undefined,
    })

    await setAuth({ uid: user.id })
    return {
      me: userDataToUser({ ...user, profile: { ...profile, private: false } }),
    }
  } catch (err) {
    log.info('error signing up with google', err)
    if (isErrorWithCode(err)) {
      return { errorCodes: [err.errorCode as SignupErrorCode] }
    }
    return { errorCodes: [SignupErrorCode.Unknown] }
  }
}

export const logOutResolver: ResolverFn<
  LogOutResult,
  unknown,
  WithDataSourcesContext,
  unknown
> = (_, __, { clearAuth, log }) => {
  try {
    clearAuth()
    return { message: 'User successfully logged out' }
  } catch (error) {
    log.error(error)
    return { errorCodes: [LogOutErrorCode.LogOutFailed] }
  }
}

export const getMeUserResolver: ResolverFn<
  User | undefined,
  unknown,
  WithDataSourcesContext,
  unknown
> = async (_obj, __, { claims }) => {
  try {
    if (!claims?.uid) {
      return undefined
    }

    const user = await userRepository.findById(claims.uid)
    if (!user) {
      return undefined
    }

    return userDataToUser(user)
  } catch (error) {
    return undefined
  }
}

export const getUserResolver: ResolverFn<
  UserResult,
  unknown,
  WithDataSourcesContext,
  QueryUserArgs
> = async (_obj, { userId: id, username }, { uid }) => {
  if (!(id || username)) {
    return { errorCodes: [UserErrorCode.BadRequest] }
  }

  const userId =
    id ||
    (username &&
      (
        await userRepository.findOneBy({
          profile: { username },
          status: StatusType.Active,
        })
      )?.id)
  if (!userId) {
    return { errorCodes: [UserErrorCode.UserNotFound] }
  }

  const userRecord = await userRepository.findById(userId)
  if (!userRecord) {
    return { errorCodes: [UserErrorCode.UserNotFound] }
  }

  return { user: userDataToUser(userRecord) }
}

export const getAllUsersResolver = authorized<UsersSuccess, UsersError>(
  async (_obj, _params) => {
    const users = await userRepository.findTopUsers()
    const result = { users: users.map((userData) => userDataToUser(userData)) }
    return result
  }
)

type ErrorWithCode = {
  errorCode: string
}

export function isErrorWithCode(error: unknown): error is ErrorWithCode {
  return (
    (error as ErrorWithCode).errorCode !== undefined &&
    typeof (error as ErrorWithCode).errorCode === 'string'
  )
}

export const deleteAccountResolver = authorized<
  DeleteAccountSuccess,
  DeleteAccountError,
  MutationDeleteAccountArgs
>(async (_, { userID }, { log }) => {
  // soft delete user and change email address for user to sign up again
  const result = await softDeleteUser(userID)
  if (!result.affected) {
    log.error('Error deleting user account')

    return {
      errorCodes: [DeleteAccountErrorCode.UserNotFound],
    }
  }

  return { userID }
})

export const updateEmailResolver = authorized<
  UpdateEmailSuccess,
  UpdateEmailError,
  MutationUpdateEmailArgs
>(async (_, { input: { email } }, { authTrx, uid, log }) => {
  try {
    const user = await userRepository.findById(uid)

    if (!user) {
      return {
        errorCodes: [UpdateEmailErrorCode.Unauthorized],
      }
    }

    if (user.source === RegistrationType.Email) {
      await authTrx(async (tx) =>
        tx.withRepository(userRepository).update(user.id, {
          email,
        })
      )

      return { email }
    }

    const result = await sendVerificationEmail({
      id: user.id,
      name: user.name,
      email,
    })
    if (!result) {
      return {
        errorCodes: [UpdateEmailErrorCode.BadRequest],
      }
    }

    return { email, verificationEmailSent: true }
  } catch (error) {
    log.error('Error updating email', error)
    return {
      errorCodes: [UpdateEmailErrorCode.BadRequest],
    }
  }
})
