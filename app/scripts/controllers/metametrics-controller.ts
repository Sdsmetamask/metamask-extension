import {
  isEqual,
  memoize,
  merge,
  omit,
  omitBy,
  pickBy,
  size,
  sum,
} from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { NameType } from '@metamask/name-controller';
import {
  getErrorMessage,
  isErrorWithMessage,
  isErrorWithStack,
} from '@metamask/utils';
import type {
  AnalyticsControllerActions,
  AnalyticsControllerState,
  AnalyticsUserTraits,
} from '@metamask/analytics-controller';
import type {
  NetworkClientId,
  NetworkControllerGetNetworkClientByIdAction,
  NetworkControllerGetStateAction,
  NetworkControllerNetworkDidChangeEvent,
} from '@metamask/network-controller';
import type { RemoteFeatureFlagControllerGetStateAction } from '@metamask/remote-feature-flag-controller';
import type { Browser } from 'webextension-polyfill';
import type { Nft } from '@metamask/assets-controllers';
import {
  BaseController,
  type ControllerGetStateAction,
  type ControllerStateChangeEvent,
  type StateMetadata,
} from '@metamask/base-controller';
import type { Messenger } from '@metamask/messenger';
import type { Json, Hex } from '@metamask/utils';
import type { InternalAccount } from '@metamask/keyring-internal-api';
import {
  ENVIRONMENT_TYPE_BACKGROUND,
  PLATFORM_FIREFOX,
} from '../../../shared/constants/app';
import {
  METAMETRICS_BACKGROUND_PAGE_OBJECT,
  MetaMetricsEventCategory,
  MetaMetricsEventName,
  MetaMetricsUserTrait,
} from '../../../shared/constants/metametrics';
import type {
  MetaMetricsEventFragment,
  MetaMetricsUserTraits,
  SegmentEventPayload,
  MetaMetricsContext,
  MetaMetricsEventPayload,
  MetaMetricsEventOptions,
  MetaMetricsPagePayload,
  MetaMetricsPageObject,
  MetaMetricsReferrerObject,
} from '../../../shared/constants/metametrics';
import { SECOND } from '../../../shared/constants/time';
import { isManifestV3 } from '../../../shared/lib/mv3.utils';
import { METAMETRICS_FINALIZE_EVENT_FRAGMENT_ALARM } from '../../../shared/constants/alarms';
import {
  checkAlarmExists,
  generateRandomId,
  getDeviceType,
  getInstallType,
  getOs,
  getPlatform,
  isValidDate,
} from '../lib/util';
import { TransactionMetaMetricsEvent } from '../../../shared/constants/transaction';
import {
  trace,
  endTrace,
  type TraceRequest,
  type EndTraceRequest,
  type TraceCallback,
} from '../../../shared/lib/trace';
import { ENVIRONMENT } from '../../../development/build/constants';
import { KeyringType } from '../../../shared/constants/keyring';
import type { captureException } from '../../../shared/lib/sentry';
import type { FlattenedBackgroundStateProxy } from '../../../shared/types';
import {
  hasABTestAnalyticsMappingForEvent,
  enrichWithABTests,
  getRemoteFeatureFlagsWithManifestOverrides,
} from '../../../shared/lib/ab-testing/ab-test-analytics';
import { getTokensControllerAllTokens } from '../../../shared/lib/selectors/assets-migration';
import { isMain } from '../../../shared/lib/build-types';
import type {
  PreferencesControllerGetStateAction,
  PreferencesControllerStateChangeEvent,
} from './preferences-controller';
import { MetaMetricsControllerMethodActions } from './metametrics-controller-method-action-types';
import {
  ANONYMOUS_EVENT_PROPERTY,
  type AnalyticsInvocationOptions,
} from './analytics/platform-adapter';

// Unique name for the controller
const controllerName = 'MetaMetricsController';

const EXTENSION_UNINSTALL_URL = 'https://metamask.io/uninstalled';

const defaultCaptureException = (err: unknown) => {
  // throw error on clean stack so its captured by platform integrations (eg sentry)
  // but does not interrupt the call stack
  setTimeout(() => {
    throw err;
  });
};

// The function is used to build a unique messageId for segment messages
// It uses actionId and uniqueIdentifier from event if present
const buildUniqueMessageId = (args: {
  uniqueIdentifier?: string;
  actionId?: string;
  isDuplicateAnonymizedEvent?: boolean;
}): string => {
  const messageIdParts = [];
  if (args.uniqueIdentifier) {
    messageIdParts.push(args.uniqueIdentifier);
  }
  if (args.actionId) {
    messageIdParts.push(args.actionId);
  }
  if (messageIdParts.length && args.isDuplicateAnonymizedEvent) {
    messageIdParts.push('0x000');
  }
  if (messageIdParts.length) {
    return messageIdParts.join('-');
  }
  return generateRandomId();
};

const exceptionsToFilter: Record<string, boolean> = {
  [`You must pass either an "anonymousId" or a "userId".`]: true,
};

/**
 * The type of a Segment event to create.
 *
 * Must correspond to the name of a method in {@link Analytics}.
 */
type SegmentEventType = 'identify' | 'track' | 'page';

/**
 * Represents a buffered trace that is stored before user consent.
 * Simplified for JSON serialization - doesn't include callback functions.
 */
type BufferedTrace = {
  type: 'start' | 'end';
  request: Record<string, Json>;
  parentTraceName?: string;
};

export type MetaMaskState = Pick<
  FlattenedBackgroundStateProxy,
  | 'ledgerTransportType'
  | 'networkConfigurationsByChainId'
  | 'internalAccounts'
  | 'allNfts'
  | 'allTokens'
  | 'theme'
  | 'dataCollectionForMarketing'
  | 'useNftDetection'
  | 'openSeaEnabled'
  | 'securityAlertsEnabled'
  | 'useTokenDetection'
  | 'names'
  | 'addressBook'
  | 'currentCurrency'
  | 'srpSessionData'
  | 'keyrings'
  | 'multichainNetworkConfigurationsByChainId'
  // TODO: Remove as this is no longer a top-level property of the flattened background state object.
  // | 'security_providers'
> & {
  preferences: Pick<
    FlattenedBackgroundStateProxy['preferences'],
    | 'privacyMode'
    | 'tokenNetworkFilter'
    | 'showNativeTokenAsMainBalance'
    | 'tokenSortConfig'
  >;
} & {
  // TODO: Remove `participateInMetaMetrics` / `metaMetricsId` here once the codebase and
  // `FlattenedBackgroundStateProxy` use `completedMetaMetricsOnboarding`, `optedIn`, and
  // `analyticsId` as the source of truth (and `MetamaskController.getState()` stops injecting the legacy
  // fields). Update `_buildUserTraitsObject` and any other `MetaMaskState` consumers accordingly.
  /** Populated by `MetamaskController.getState()` from analytics + metrics prompt completion. */
  participateInMetaMetrics: boolean | null;
  metaMetricsId: string | null;
};

/**
 * {@link MetaMetricsController}'s metadata.
 *
 * This allows us to choose if fields of the state should be persisted or not
 * using the `persist` flag; and if they can be sent to Sentry or not, using
 * the `anonymous` flag.
 */
const controllerMetadata: StateMetadata<MetaMetricsControllerState> = {
  completedMetaMetricsOnboarding: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: true,
    usedInUi: true,
  },
  latestNonAnonymousEventTimestamp: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: true,
    usedInUi: true,
  },
  fragments: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: false,
    usedInUi: true,
  },
  eventsBeforeMetricsOptIn: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: false,
    usedInUi: false,
  },
  tracesBeforeMetricsOptIn: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: false,
    usedInUi: false,
  },
  traits: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: false,
    usedInUi: false,
  },
  dataCollectionForMarketing: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: false,
    usedInUi: true,
  },
  marketingCampaignCookieId: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: true,
    usedInUi: false,
  },
  segmentApiCalls: {
    includeInStateLogs: true,
    persist: true,
    includeInDebugSnapshot: false,
    usedInUi: false,
  },
};

/**
 * The state that MetaMetricsController stores.
 *
 * @property completedMetaMetricsOnboarding - Whether the user has completed the metrics participation prompt (onboarding/settings).
 * @property latestNonAnonymousEventTimestamp - The timestamp at which last non anonymous event is tracked.
 * @property fragments - Object keyed by UUID with stored fragments as values.
 * @property eventsBeforeMetricsOptIn - Array of queued events added before a user opts into metrics.
 * @property tracesBeforeMetricsOptIn - Array of queued traces added before a user opts into metrics.
 * @property traits - Traits that are not derived from other state keys.
 * @property dataCollectionForMarketing - Flag to determine if data collection for marketing is enabled.
 * @property marketingCampaignCookieId - The marketing campaign cookie id.
 * @property segmentApiCalls - Object keyed by messageId with segment event type and payload as values.
 */
/**
 * Shape routed to `#submitSegmentAPICall`. Matches Segment payloads plus optional
 * `sensitiveProperties` for AnalyticsController only (not Segment fields).
 */
type SegmentSubmissionPayload = Partial<SegmentEventPayload> & {
  sensitiveProperties?: Record<string, Json>;
};

export type MetaMetricsControllerState = {
  completedMetaMetricsOnboarding: boolean;
  latestNonAnonymousEventTimestamp: number;
  fragments: Record<string, MetaMetricsEventFragment>;
  eventsBeforeMetricsOptIn: MetaMetricsEventPayload[];
  tracesBeforeMetricsOptIn: BufferedTrace[];
  traits: MetaMetricsUserTraits;
  dataCollectionForMarketing: boolean | null;
  marketingCampaignCookieId: string | null;
  segmentApiCalls: Record<
    string,
    {
      eventType: SegmentEventType;
      payload: SegmentSubmissionPayload & { timestamp: string };
    }
  >;
};

/**
 * Returns the state of the {@link MetaMetricsController}.
 */
export type MetaMetricsControllerGetStateAction = ControllerGetStateAction<
  typeof controllerName,
  MetaMetricsControllerState
>;

/**
 * Actions exposed by the {@link MetaMetricsController}.
 */
export type MetaMetricsControllerActions =
  | MetaMetricsControllerGetStateAction
  | MetaMetricsControllerMethodActions;

/**
 * Event emitted when the state of the {@link MetaMetricsController} changes.
 */
export type MetaMetricsControllerStateChangeEvent = ControllerStateChangeEvent<
  typeof controllerName,
  MetaMetricsControllerState
>;

export type MetaMetricsControllerEvents = MetaMetricsControllerStateChangeEvent;

/**
 * Actions that this controller is allowed to call.
 */
export type AllowedActions =
  | PreferencesControllerGetStateAction
  | NetworkControllerGetStateAction
  | NetworkControllerGetNetworkClientByIdAction
  | RemoteFeatureFlagControllerGetStateAction
  | AnalyticsControllerActions;

/**
 * Events that this controller is allowed to subscribe.
 */
export type AllowedEvents =
  | PreferencesControllerStateChangeEvent
  | NetworkControllerNetworkDidChangeEvent;

/**
 * Messenger type for the {@link MetaMetricsController}.
 */
export type MetaMetricsControllerMessenger = Messenger<
  typeof controllerName,
  MetaMetricsControllerActions | AllowedActions,
  MetaMetricsControllerEvents | AllowedEvents
>;

type CaptureException = typeof captureException | ((err: unknown) => void);

export type MetaMetricsControllerOptions = {
  state?: Partial<MetaMetricsControllerState>;
  messenger: MetaMetricsControllerMessenger;
  version: string;
  environment: string;
  extension: Browser;
  captureException?: CaptureException;
};

/**
 * Function to get default state of the {@link MetaMetricsController}.
 */
export const getDefaultMetaMetricsControllerState =
  (): MetaMetricsControllerState => ({
    completedMetaMetricsOnboarding: false,
    dataCollectionForMarketing: null,
    marketingCampaignCookieId: null,
    latestNonAnonymousEventTimestamp: 0,
    eventsBeforeMetricsOptIn: [],
    tracesBeforeMetricsOptIn: [],
    traits: {},
    fragments: {},
    segmentApiCalls: {},
  });

const MESSENGER_EXPOSED_METHODS = [
  'addEventBeforeMetricsOptIn',
  'addTraceBeforeMetricsOptIn',
  'bufferedEndTrace',
  'bufferedTrace',
  'clearEventsAfterMetricsOptIn',
  'clearTracesAfterMetricsOptIn',
  'createEventFragment',
  'deleteEventFragment',
  'finalizeAbandonedFragments',
  'finalizeEventFragment',
  'getEventFragmentById',
  'getMetaMetricsId',
  'handleMetaMaskStateUpdate',
  'identify',
  'processAbandonedFragment',
  'setDataCollectionForMarketing',
  'setMarketingCampaignCookieId',
  'setParticipateInMetaMetrics',
  'trackEvent',
  'trackEventsAfterMetricsOptIn',
  'trackPage',
  'trackTracesAfterMetricsOptIn',
  'updateEventFragment',
  'updateExtensionUninstallUrl',
  'updateTraits',
] as const;

export class MetaMetricsController extends BaseController<
  typeof controllerName,
  MetaMetricsControllerState,
  MetaMetricsControllerMessenger
> {
  #captureException: CaptureException;

  chainId: Hex;

  locale: string;

  previousUserTraits?: MetaMetricsUserTraits;

  version: MetaMetricsControllerOptions['version'];

  #extension: MetaMetricsControllerOptions['extension'];

  #environment: MetaMetricsControllerOptions['environment'];

  #analyticsGetState(): AnalyticsControllerState {
    return this.messenger.call('AnalyticsController:getState');
  }

  /**
   * @param options
   * @param options.state - Initial controller state.
   * @param options.messenger - Messenger used to communicate with BaseV2 controller.
   * @param options.version - The version of the extension
   * @param options.environment - The environment the extension is running in
   * @param options.extension - webextension-polyfill
   * @param options.captureException
   */
  constructor({
    state = {},
    messenger,
    version,
    environment,
    extension,
    captureException = defaultCaptureException,
  }: MetaMetricsControllerOptions) {
    super({
      name: controllerName,
      metadata: controllerMetadata,
      state: {
        ...getDefaultMetaMetricsControllerState(),
        ...state,
      },
      messenger,
    });

    this.#captureException = (err: unknown) => {
      const message = getErrorMessage(err);
      // This is a temporary measure. Currently there are errors flooding sentry due to a problem in how we are tracking anonymousId
      // We intend on removing this as soon as we understand how to correctly solve that problem.
      if (!exceptionsToFilter[message]) {
        captureException(err);
      }
    };
    this.chainId = this.#getCurrentChainId();
    const preferencesControllerState = this.messenger.call(
      'PreferencesController:getState',
    );
    this.locale = preferencesControllerState.currentLocale.replace('_', '-');
    this.version =
      environment === 'production' ? version : `${version}-${environment}`;
    this.#extension = extension;
    this.#environment = environment;

    this.messenger.registerMethodActionHandlers(
      this,
      MESSENGER_EXPOSED_METHODS,
    );

    const abandonedFragments = omitBy(state.fragments, 'persist');

    this.messenger.subscribe(
      'PreferencesController:stateChange',
      ({ currentLocale }) => {
        this.locale = currentLocale?.replace('_', '-');
      },
    );

    this.messenger.subscribe(
      'NetworkController:networkDidChange',
      ({ selectedNetworkClientId }) => {
        this.chainId = this.#getCurrentChainId(selectedNetworkClientId);
      },
    );

    // Track abandoned fragments that weren't properly cleaned up.
    // Abandoned fragments are those that were stored in persistent memory
    // and are available at controller instance creation, but do not have the
    // 'persist' flag set. This means anytime the extension is unlocked, any
    // fragments that are not marked as persistent will be purged and the
    // failure event will be emitted.
    Object.values(abandonedFragments).forEach((fragment) => {
      this.processAbandonedFragment(fragment);
    });

    // Code below submits any pending segmentApiCalls to Segment if/when the controller is re-instantiated
    if (isManifestV3) {
      // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31880
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      Object.values(state.segmentApiCalls || {}).forEach(
        ({ eventType, payload }) => {
          try {
            this.#submitSegmentAPICall(eventType, payload);
          } catch (error) {
            this.#captureException(error);
          }
        },
      );
    }

    // Close out event fragments that were created but not progressed. An
    // interval is used to routinely check if a fragment has not been updated
    // within the fragment's timeout window. When creating a new event fragment
    // a timeout can be specified that will cause an abandoned event to be
    // tracked if the event isn't progressed within that amount of time.
    if (isManifestV3) {
      /* eslint-disable no-undef */
      this.#extension.alarms.getAll().then((alarms) => {
        const hasAlarm = checkAlarmExists(
          alarms,
          METAMETRICS_FINALIZE_EVENT_FRAGMENT_ALARM,
        );

        if (!hasAlarm) {
          this.#extension.alarms.create(
            METAMETRICS_FINALIZE_EVENT_FRAGMENT_ALARM,
            {
              delayInMinutes: 1,
              periodInMinutes: 1,
            },
          );
        }
      });
      this.#extension.alarms.onAlarm.addListener((alarmInfo) => {
        if (alarmInfo.name === METAMETRICS_FINALIZE_EVENT_FRAGMENT_ALARM) {
          this.finalizeAbandonedFragments();
        }
      });
    } else {
      setInterval(() => {
        this.finalizeAbandonedFragments();
      }, SECOND * 30);
    }
  }

  /**
   * Gets the current chain ID.
   *
   * @param networkClientId - The network client ID to get the chain ID for.
   */
  #getCurrentChainId(networkClientId?: NetworkClientId): Hex {
    const selectedNetworkClientId =
      // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31880
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      networkClientId ||
      this.messenger.call('NetworkController:getState').selectedNetworkClientId;
    const {
      configuration: { chainId },
    } = this.messenger.call(
      'NetworkController:getNetworkClientById',
      selectedNetworkClientId,
    );
    return chainId;
  }

  finalizeAbandonedFragments(): void {
    Object.values(this.state.fragments).forEach((fragment) => {
      if (
        fragment.timeout &&
        fragment.lastUpdated &&
        Date.now() - fragment.lastUpdated / 1000 > fragment.timeout
      ) {
        this.processAbandonedFragment(fragment);
      }
    });
  }

  /**
   * Create an event fragment in state and returns the event fragment object.
   *
   * @param options - Fragment settings and properties to initiate the fragment with.
   */
  createEventFragment(
    options: Omit<MetaMetricsEventFragment, 'id'>,
  ): MetaMetricsEventFragment {
    if (!options.successEvent) {
      throw new Error(
        `Must specify success event. Success event was: ${
          options.event
          // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31893
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        }. Payload keys were: ${Object.keys(options)}. ${
          typeof options.properties === 'object'
            ? // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31893
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              `Payload property keys were: ${Object.keys(options.properties)}`
            : ''
        }`,
      );
    }

    const { fragments } = this.state;

    const id = options.uniqueIdentifier ?? uuidv4();
    const fragment = {
      id,
      ...options,
      lastUpdated: Date.now(),
    };

    /**
     * HACK: "transaction-submitted-<id>" fragment hack
     * A "transaction-submitted-<id>" fragment may exist following the "Transaction Added"
     * event to persist accumulated event fragment props to the "Transaction Submitted" event
     * which fires after a user confirms a transaction. Rejecting a confirmation does not fire the
     * "Transaction Submitted" event. In this case, these abandoned fragments will be deleted
     * instead of finalized with canDeleteIfAbandoned set to true.
     */
    const hasExistingSubmittedFragment =
      options.initialEvent === TransactionMetaMetricsEvent.submitted &&
      fragments[id];

    const additionalFragmentProps = hasExistingSubmittedFragment
      ? {
          ...fragments[id],
          canDeleteIfAbandoned: false,
        }
      : {};

    const mergedFragment = merge(
      {},
      additionalFragmentProps,
      fragment,
    ) as MetaMetricsEventFragment;
    this.update((state) => {
      Object.assign(state.fragments, { [id]: mergedFragment });
    });

    if (fragment.initialEvent) {
      this.trackEvent({
        event: fragment.initialEvent,
        category: fragment.category,
        properties: fragment.properties,
        sensitiveProperties: fragment.sensitiveProperties,
        page: fragment.page,
        referrer: fragment.referrer,
        revenue: fragment.revenue,
        value: fragment.value,
        currency: fragment.currency,
        environmentType: fragment.environmentType,
        actionId: options.actionId,
        uniqueIdentifier: options.uniqueIdentifier,
      });
    }

    return fragment;
  }

  /**
   * Returns the fragment stored in memory with provided id or undefined if it
   * does not exist.
   *
   * @param id - id of fragment to retrieve
   */
  getEventFragmentById(id: string): MetaMetricsEventFragment {
    return this.state.fragments[id];
  }

  /**
   * Deletes to finalizes event fragment based on the canDeleteIfAbandoned property.
   *
   * @param fragment
   */
  processAbandonedFragment(fragment: MetaMetricsEventFragment): void {
    if (fragment.canDeleteIfAbandoned) {
      this.deleteEventFragment(fragment.id);
    } else {
      this.finalizeEventFragment(fragment.id, { abandoned: true });
    }
  }

  /**
   * Updates an event fragment in state
   *
   * @param id - The fragment id to update
   * @param payload - Fragment settings and properties to initiate the fragment with.
   */
  updateEventFragment(
    id: string,
    payload: Partial<MetaMetricsEventFragment>,
  ): void {
    const { fragments } = this.state;

    const fragment = fragments[id];

    /**
     * HACK: "transaction-submitted-<id>" fragment hack
     * Creates a "transaction-submitted-<id>" fragment if it does not exist to persist
     * accumulated event metrics. In the case it is unused, the abandoned fragment will
     * eventually be deleted with canDeleteIfAbandoned set to true.
     */
    const createIfNotFound = !fragment && id.includes('transaction-submitted-');

    if (createIfNotFound) {
      const newFragment: MetaMetricsEventFragment = {
        canDeleteIfAbandoned: true,
        category: MetaMetricsEventCategory.Transactions,
        successEvent: TransactionMetaMetricsEvent.finalized,
        id,
        ...payload,
        lastUpdated: Date.now(),
      };
      this.update((state) => {
        Object.assign(state.fragments, { [id]: newFragment });
      });
      return;
    } else if (!fragment) {
      throw new Error(`Event fragment with id ${id} does not exist.`);
    }

    const updatedFragment = merge(
      {} as MetaMetricsEventFragment,
      fragment,
      {
        ...payload,
        lastUpdated: Date.now(),
      },
    ) as MetaMetricsEventFragment;
    this.update((state) => {
      Object.assign(state.fragments, { [id]: updatedFragment });
    });
  }

  /**
   * Deletes an event fragment from state
   *
   * @param id - The fragment id to delete
   */
  deleteEventFragment(id: string): void {
    if (this.state.fragments[id]) {
      this.update((state) => {
        delete state.fragments[id];
      });
    }
  }

  /**
   * Finalizes a fragment, tracking either a success event or failure Event
   * and then removes the fragment from state.
   *
   * @param id - UUID of the event fragment to be closed
   * @param options
   * @param options.abandoned - if true track the failure event instead of the success event
   * @param options.page - page the final event occurred on. This will override whatever is set on the fragment
   * @param options.referrer - Dapp that originated the fragment. This is for fallback only, the fragment referrer
   * property will take precedence.
   */
  finalizeEventFragment(
    id: string,
    {
      abandoned = false,
      page,
      referrer,
    }: {
      abandoned?: boolean;
      page?: MetaMetricsPageObject;
      referrer?: MetaMetricsReferrerObject;
    } = {},
  ): void {
    const fragment = this.state.fragments[id];
    if (!fragment) {
      throw new Error(`Funnel with id ${id} does not exist.`);
    }

    const eventName = abandoned ? fragment.failureEvent : fragment.successEvent;

    this.trackEvent({
      event: eventName ?? '',
      category: fragment.category,
      properties: fragment.properties,
      sensitiveProperties: fragment.sensitiveProperties,
      page: page ?? fragment.page,
      referrer: fragment.referrer ?? referrer,
      revenue: fragment.revenue,
      value: fragment.value,
      currency: fragment.currency,
      environmentType: fragment.environmentType,
      actionId: fragment.actionId,
      // We append success or failure to the unique-identifier so that the
      // messageId can still be idempotent, but so that it differs from the
      // initial event fired. The initial event was preventing new events from
      // making it to mixpanel because they were using the same unique ID as
      // the events processed in other parts of the fragment lifecycle.
      uniqueIdentifier: fragment.uniqueIdentifier
        ? `${fragment.uniqueIdentifier}-${abandoned ? 'failure' : 'success'}`
        : undefined,
    });
    this.update((state) => {
      delete state.fragments[id];
    });
  }

  /**
   * Calls this._identify with validated metaMetricsId and user traits if user is participating
   * in the MetaMetrics analytics program
   *
   * @param userTraits
   */
  identify(userTraits: Partial<MetaMetricsUserTraits>): void {
    const { analyticsId, optedIn } = this.#analyticsGetState();
    if (!optedIn || !analyticsId || !userTraits) {
      return;
    }
    if (typeof userTraits !== 'object') {
      console.warn(
        `MetaMetricsController#identify: userTraits parameter must be an object. Received type: ${typeof userTraits}`,
      );
      return;
    }

    const allValidTraits = this.#buildValidTraits(userTraits);

    if (Object.keys(allValidTraits).length === 0) {
      return;
    }

    this.#identify(allValidTraits);
  }

  // It sets an uninstall URL ("Sorry to see you go!" page),
  // which is opened if a user uninstalls the extension.
  // This method should only be called after the user has made a decision about MetaMetrics participation.
  updateExtensionUninstallUrl(
    participateInMetaMetrics: boolean,
    metaMetricsId: string,
  ): void {
    const query: {
      mmi?: string;
      env?: string;
      av: string;
    } = {
      av: this.version,
    };
    if (participateInMetaMetrics) {
      // We only want to track these things if a user opted into metrics.
      query.mmi = Buffer.from(metaMetricsId).toString('base64');
      query.env = this.#environment;
    }
    const queryString = new URLSearchParams(query);

    // this.extension not currently defined in tests
    if (this.#extension && this.#extension.runtime) {
      this.#extension.runtime.setUninstallURL(
        // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31893
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `${EXTENSION_UNINSTALL_URL}?${queryString}`,
      );
    }
  }

  /**
   * Setter for the `participateInMetaMetrics` property
   *
   * @param participateInMetaMetrics - Whether or not the user wants to participate in MetaMetrics if not set
   * @returns The string of the new metametrics id, or null
   */
  async setParticipateInMetaMetrics(
    participateInMetaMetrics: boolean | null,
  ): Promise<string | null> {
    const analyticsId = this.getMetaMetricsId();

    if (participateInMetaMetrics === true) {
      this.messenger.call('AnalyticsController:optIn');
    } else {
      this.messenger.call('AnalyticsController:optOut');
    }

    this.update((state) => {
      state.completedMetaMetricsOnboarding =
        participateInMetaMetrics !== null;
    });

    if (participateInMetaMetrics) {
      this.trackEventsAfterMetricsOptIn();
      this.clearEventsAfterMetricsOptIn();
      this.trackTracesAfterMetricsOptIn();
      this.clearTracesAfterMetricsOptIn();
    } else {
      if (participateInMetaMetrics === false) {
        // Drop any UI-buffered pre-submit events/traces; they must not be sent after opt-out.
        this.clearEventsAfterMetricsOptIn();
        this.clearTracesAfterMetricsOptIn();
      }
      if (this.state.marketingCampaignCookieId) {
        this.setMarketingCampaignCookieId(null);
      }
    }

    if (
      isMain() &&
      this.#environment !== ENVIRONMENT.DEVELOPMENT &&
      participateInMetaMetrics !== null
    ) {
      this.updateExtensionUninstallUrl(
        participateInMetaMetrics === true,
        analyticsId,
      );
    }

    return analyticsId;
  }

  setDataCollectionForMarketing(dataCollectionForMarketing: boolean): string {
    const { analyticsId } = this.#analyticsGetState();

    this.update((state) => {
      state.dataCollectionForMarketing = dataCollectionForMarketing;
    });

    if (!dataCollectionForMarketing && this.state.marketingCampaignCookieId) {
      this.setMarketingCampaignCookieId(null);
    }

    return analyticsId;
  }

  setMarketingCampaignCookieId(marketingCampaignCookieId: string | null): void {
    this.update((state) => {
      state.marketingCampaignCookieId = marketingCampaignCookieId;
    });
  }

  /**
   * track a page view with Segment
   *
   * @param payload - details of the page viewed.
   */
  trackPage(payload: MetaMetricsPagePayload): void {
    try {
      const { optedIn } = this.#analyticsGetState();
      if (!optedIn) {
        return;
      }

      const { name, params, environmentType, page, referrer, actionId } =
        payload;
      this.#submitSegmentAPICall('page', {
        messageId: buildUniqueMessageId({ actionId }),
        name,
        properties: {
          params,
          locale: this.locale,
          // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31860
          // eslint-disable-next-line @typescript-eslint/naming-convention
          chain_id: this.chainId,
          // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31860
          // eslint-disable-next-line @typescript-eslint/naming-convention
          environment_type: environmentType,
        },
        context: this.#buildContext(referrer, page),
      });
    } catch (err) {
      this.#captureException(err);
    }
  }

  /**
   * submits a metametrics event, not waiting for it to complete or allowing its error to bubble up
   *
   * @param payload - details of the event
   * @param options - options for handling/routing the event
   */
  trackEvent(
    payload: MetaMetricsEventPayload,
    options?: MetaMetricsEventOptions,
  ): void {
    // validation is not caught and handled
    this.#validatePayload(payload);
    this.#submitEvent(payload, options).catch((err) => {
      this.#captureException(err);
    });
  }

  /**
   * submits (or queues for submission) a metametrics event, performing necessary payload manipulation and
   * routing the event to the appropriate segment source.
   *
   * @param payload - details of the event
   * @param options - options for handling/routing the event
   */
  async #submitEvent(
    payload: MetaMetricsEventPayload,
    options?: MetaMetricsEventOptions,
  ): Promise<void> {
    const { useExternalServices } = this.messenger.call(
      'PreferencesController:getState',
    );
    const isBasicFunctionalityDisabled = !useExternalServices;
    if (isBasicFunctionalityDisabled) {
      // If basic functionality is disabled, we block all events
      return;
    }

    const { optedIn } = this.#analyticsGetState();
    if (!optedIn && payload.event !== MetaMetricsEventName.MetricsOptOut) {
      return;
    }

    let identifiedPayload = payload;

    const hasABTestAnalyticsMapping = hasABTestAnalyticsMappingForEvent(
      payload.event,
    );
    const hasActiveABTests = payload.properties?.active_ab_tests !== undefined;

    let normalizedPayload = payload;

    if (hasActiveABTests) {
      try {
        normalizedPayload = enrichWithABTests(payload, null, []);
      } catch {
        normalizedPayload = payload;
      }
    }

    identifiedPayload = normalizedPayload;

    if (hasABTestAnalyticsMapping) {
      try {
        identifiedPayload = enrichWithABTests(
          normalizedPayload,
          this.#getRemoteFeatureFlags(),
        );
      } catch {
        identifiedPayload = normalizedPayload;
      }
    }

    if (
      identifiedPayload.sensitiveProperties &&
      options?.excludeMetaMetricsId === true
    ) {
      throw new Error(
        'sensitiveProperties was specified in an event payload that also set the excludeMetaMetricsId flag',
      );
    }

    await this.#track(this.#buildEventPayload(identifiedPayload), options);
  }

  /**
   * validates a metametrics event
   *
   * @param payload - details of the event
   */
  #validatePayload(payload: MetaMetricsEventPayload): void {
    // event and category are required fields for all payloads
    if (!payload.event) {
      throw new Error(
        `Must specify event. Event was: ${
          payload.event
          // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31893
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        }. Payload keys were: ${Object.keys(payload)}. ${
          typeof payload.properties === 'object'
            ? // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31893
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              `Payload property keys were: ${Object.keys(payload.properties)}`
            : ''
        }`,
      );
    }
  }

  handleMetaMaskStateUpdate(newState: MetaMaskState): void {
    const userTraits = this._buildUserTraitsObject(newState);
    if (userTraits) {
      this.identify(userTraits);
    }
  }

  // Track all queued events after a user opted into metrics.
  trackEventsAfterMetricsOptIn(): void {
    const { eventsBeforeMetricsOptIn } = this.state;
    eventsBeforeMetricsOptIn.forEach((eventBeforeMetricsOptIn) => {
      this.trackEvent(eventBeforeMetricsOptIn);
    });
  }

  // Once we track queued events after a user opts into metrics, we want to clear the event queue.
  clearEventsAfterMetricsOptIn(): void {
    this.update((state) => {
      state.eventsBeforeMetricsOptIn = [];
    });
  }

  // It adds an event into a queue, which is only tracked if a user opts into metrics.
  addEventBeforeMetricsOptIn(event: MetaMetricsEventPayload): void {
    this.update((state) => {
      const queue =
        state.eventsBeforeMetricsOptIn as unknown as MetaMetricsEventPayload[];
      queue.push(event);
    });
  }

  // Track all queued traces after a user opted into metrics.
  trackTracesAfterMetricsOptIn(): void {
    const { tracesBeforeMetricsOptIn } = this.state;
    tracesBeforeMetricsOptIn.forEach((bufferedTrace) => {
      if (bufferedTrace.type === 'start') {
        trace(bufferedTrace.request as TraceRequest);
      } else if (bufferedTrace.type === 'end') {
        endTrace(bufferedTrace.request as EndTraceRequest);
      }
    });
  }

  // Once we track queued traces after a user opts into metrics, we want to clear the trace queue.
  clearTracesAfterMetricsOptIn(): void {
    this.update((state) => {
      state.tracesBeforeMetricsOptIn = [];
    });
  }

  // It adds a trace into a queue, which is only tracked if a user opts into metrics.
  addTraceBeforeMetricsOptIn(traceData: BufferedTrace): void {
    this.update((state) => {
      const queue =
        state.tracesBeforeMetricsOptIn as unknown as BufferedTrace[];
      queue.push(traceData);
    });
  }

  /**
   * Buffered trace method that checks consent and either buffers or executes immediately
   *
   * @param request - The trace request
   * @param fn - Optional callback function to trace
   * @returns The result of the trace callback or undefined if buffered
   */
  bufferedTrace<TraceResultType>(
    request: TraceRequest,
    fn?: TraceCallback<TraceResultType>,
  ): TraceResultType | undefined {
    if (this.#analyticsGetState().optedIn) {
      return fn ? trace(request, fn) : (trace(request) as TraceResultType);
    }

    // Extract parent trace name if parentContext exists
    let parentTraceName: string | undefined;
    if (request.parentContext && typeof request.parentContext === 'object') {
      const parentSpan = request.parentContext as { _name?: string };
      parentTraceName = parentSpan?._name;
    }

    this.addTraceBeforeMetricsOptIn({
      type: 'start',
      request: {
        ...request,
        parentContext: undefined as unknown as Json, // Remove original parentContext to avoid invalid references
        // Use Date.now() as performance.timeOrigin is only valid for measuring durations within
        // the same session; it won't produce valid event times for Sentry if buffered and flushed later
        startTime: request.startTime ?? Date.now(),
      },
      parentTraceName, // Store the parent trace name for later reconnection
    });

    return undefined;
  }

  /**
   * Buffered end trace method that checks consent and either buffers or executes immediately
   *
   * @param request - The end trace request
   */
  bufferedEndTrace(request: EndTraceRequest): void {
    if (this.#analyticsGetState().optedIn) {
      endTrace(request);
    } else {
      this.addTraceBeforeMetricsOptIn({
        type: 'end',
        request: {
          ...request,
          // Use Date.now() as performance.timeOrigin is only valid for measuring durations within
          // the same session; it won't produce valid event times for Sentry if buffered and flushed later
          timestamp: request.timestamp ?? Date.now(),
        },
      });
    }
  }

  // Add or update traits for tracking.
  updateTraits(newTraits: MetaMetricsUserTraits): void {
    this.update((state) => {
      state.traits = { ...state.traits, ...newTraits };
    });
  }

  // Retrieve the client metametrics id from AnalyticsController state
  getMetaMetricsId(): string {
    const { analyticsId } = this.#analyticsGetState();
    return analyticsId;
  }

  /** PRIVATE METHODS */

  /**
   * Build the context object to attach to page and track events.
   *
   * @private
   * @param referrer - dapp origin that initialized
   * the notification window.
   * @param page - page object describing the current
   * view of the extension. Defaults to the background-process object.
   */
  #buildContext(
    referrer: MetaMetricsContext['referrer'],
    page: MetaMetricsContext['page'] = METAMETRICS_BACKGROUND_PAGE_OBJECT,
  ): MetaMetricsContext {
    return {
      app: {
        name: 'MetaMask Extension',
        version: this.version,
      },
      userAgent: window.navigator.userAgent,
      page,
      referrer,
      marketingCampaignCookieId: this.state.marketingCampaignCookieId,
    };
  }

  #getRemoteFeatureFlags(): Record<string, unknown> {
    return getRemoteFeatureFlagsWithManifestOverrides(
      this.messenger.call('RemoteFeatureFlagController:getState')
        ?.remoteFeatureFlags as Record<string, unknown> | undefined,
    );
  }

  /**
   * Build's the event payload, processing all fields into a format that can be
   * fed to Segment's track method
   *
   * @private
   * @param rawPayload - raw payload provided to trackEvent
   * @returns formatted event payload for segment
   */
  #buildEventPayload(
    rawPayload: MetaMetricsEventPayload,
  ): SegmentEventPayload & Pick<SegmentSubmissionPayload, 'sensitiveProperties'> {
    const {
      event,
      properties,
      revenue,
      value,
      currency,
      category,
      page,
      referrer,
      environmentType = ENVIRONMENT_TYPE_BACKGROUND,
      timestamp,
      sensitiveProperties,
    } = rawPayload;

    let chainId;
    if (
      properties &&
      'chain_id_caip' in properties &&
      typeof properties.chain_id_caip === 'string'
    ) {
      chainId = null;
    } else if (
      properties &&
      'chain_id' in properties &&
      typeof properties.chain_id === 'string'
    ) {
      chainId = properties.chain_id;
    } else {
      chainId = this.chainId;
    }

    return {
      event,
      messageId: buildUniqueMessageId(rawPayload),
      properties: {
        // These values are omitted from properties because they have special meaning
        // in segment. https://segment.com/docs/connections/spec/track/#properties.
        // to avoid accidentally using these inappropriately, you must add them as top
        // level properties on the event payload. We also exclude locale to prevent consumers
        // from overwriting this context level property. We track it as a property
        // because not all destinations map locale from context.
        ...omit(properties, ['revenue', 'locale', 'currency', 'value']),
        revenue,
        value,
        currency,
        category,
        locale: this.locale,
        // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31860
        // eslint-disable-next-line @typescript-eslint/naming-convention
        chain_id: chainId,
        // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31860
        // eslint-disable-next-line @typescript-eslint/naming-convention
        environment_type: environmentType,
      },
      context: this.#buildContext(referrer, page),
      timestamp,
      sensitiveProperties,
    };
  }

  /**
   * This method generates the MetaMetrics user traits object, omitting any
   * traits that have not changed since the last invocation of this method.
   *
   * @param metamaskState - Full metamask state object.
   * @returns traits that have changed since last update
   */
  _buildUserTraitsObject(
    metamaskState: MetaMaskState,
  ): Partial<MetaMetricsUserTraits> | null {
    const { traits } = this.state;
    const storageKindTrait = traits[MetaMetricsUserTrait.StorageKind];

    const currentTraits = {
      [MetaMetricsUserTrait.AddressBookEntries]: sum(
        Object.values(metamaskState.addressBook).map(size),
      ),
      [MetaMetricsUserTrait.InstallDateExt]:
        // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31880
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        traits[MetaMetricsUserTrait.InstallDateExt] || '',
      ...(storageKindTrait
        ? { [MetaMetricsUserTrait.StorageKind]: storageKindTrait }
        : {}),
      [MetaMetricsUserTrait.LedgerConnectionType]:
        metamaskState.ledgerTransportType,
      [MetaMetricsUserTrait.NetworksAdded]: Object.values(
        metamaskState.networkConfigurationsByChainId,
      ).map((networkConfiguration) => networkConfiguration.chainId),
      [MetaMetricsUserTrait.NetworksWithoutTicker]: Object.values(
        metamaskState.networkConfigurationsByChainId,
      )
        .filter(({ nativeCurrency }) => !nativeCurrency)
        .map(({ chainId }) => chainId),
      // caip-2 formatted
      [MetaMetricsUserTrait.ChainIdList]: [
        ...Object.keys(metamaskState.networkConfigurationsByChainId).map(
          (hexChainId) => `eip155:${parseInt(hexChainId, 16)}`,
        ),
        ...Object.keys(
          metamaskState?.multichainNetworkConfigurationsByChainId || {},
        ), // the state here is already caip-2 formatted
      ],
      [MetaMetricsUserTrait.NftAutodetectionEnabled]:
        metamaskState.useNftDetection,
      [MetaMetricsUserTrait.NumberOfAccounts]: Object.values(
        metamaskState.internalAccounts.accounts,
      ).length,
      [MetaMetricsUserTrait.NumberOfNftCollections]:
        this.#getAllUniqueNFTAddressesLength(metamaskState.allNfts),
      [MetaMetricsUserTrait.NumberOfNfts]: this.#getAllNFTsFlattened(
        metamaskState.allNfts,
      ).length,
      [MetaMetricsUserTrait.NumberOfTokens]: this.#getNumberOfTokens(
        getTokensControllerAllTokens({ metamask: metamaskState }),
      ),
      [MetaMetricsUserTrait.OpenSeaApiEnabled]: metamaskState.openSeaEnabled,
      [MetaMetricsUserTrait.ThreeBoxEnabled]: false, // deprecated, hard-coded as false
      [MetaMetricsUserTrait.Theme]: metamaskState.theme || 'default',
      [MetaMetricsUserTrait.TokenDetectionEnabled]:
        metamaskState.useTokenDetection,
      [MetaMetricsUserTrait.ShowNativeTokenAsMainBalance]:
        metamaskState.preferences?.showNativeTokenAsMainBalance ?? false,
      [MetaMetricsUserTrait.CurrentCurrency]: metamaskState.currentCurrency,
      [MetaMetricsUserTrait.SecurityProviders]:
        metamaskState.securityAlertsEnabled ? ['blockaid'] : [],
      [MetaMetricsUserTrait.PetnameAddressCount]:
        this.#getPetnameAddressCount(metamaskState),
      [MetaMetricsUserTrait.IsMetricsOptedIn]:
        metamaskState.participateInMetaMetrics,
      [MetaMetricsUserTrait.HasMarketingConsent]:
        metamaskState.dataCollectionForMarketing,
      [MetaMetricsUserTrait.TokenSortPreference]:
        metamaskState.preferences?.tokenSortConfig?.key || '',
      [MetaMetricsUserTrait.PrivacyModeEnabled]:
        metamaskState.preferences?.privacyMode ?? false,
      [MetaMetricsUserTrait.NetworkFilterPreference]: Object.keys(
        metamaskState.preferences?.tokenNetworkFilter || {},
      ),
      [MetaMetricsUserTrait.ProfileId]: Object.entries(
        metamaskState.srpSessionData || {},
      )?.[0]?.[1]?.profile?.profileId,
      [MetaMetricsUserTrait.Platform]: getPlatform(),
      [MetaMetricsUserTrait.InstallType]: getInstallType(),
      [MetaMetricsUserTrait.DeviceType]: getDeviceType(),
      [MetaMetricsUserTrait.Os]: getOs(),
      ...this.#getAccountCompositionTraits(metamaskState),
    };

    if (!this.previousUserTraits && metamaskState.participateInMetaMetrics) {
      this.previousUserTraits = currentTraits;
      return currentTraits;
    }

    if (
      this.previousUserTraits &&
      !isEqual(this.previousUserTraits, currentTraits)
    ) {
      const updates = pickBy(currentTraits, (v, k) => {
        // @ts-expect-error It's okay that `k` may not be a key of `this.previousUserTraits`, because we assume `isEqual` can handle it
        const previous = this.previousUserTraits[k];
        return !isEqual(previous, v);
      });

      if (metamaskState.participateInMetaMetrics) {
        this.previousUserTraits = currentTraits;
      }

      return updates;
    }

    return null;
  }

  /**
   * Returns a new object of all valid user traits. For dates, we transform them into ISO-8601 timestamp strings.
   *
   * @see {@link https://segment.com/docs/connections/spec/common/#timestamps}
   * @param userTraits
   */
  #buildValidTraits(
    userTraits: Partial<MetaMetricsUserTraits>,
  ): MetaMetricsUserTraits {
    const validTraits: Record<string, string> = {};

    for (const [key, value] of Object.entries(userTraits)) {
      if (this.#isValidTraitDate(value)) {
        validTraits[key] = value.toISOString();
      } else if (this.#isValidTrait(value)) {
        (validTraits as Record<string, typeof value>)[key] = value;
      } else {
        console.warn(
          `MetaMetricsController: "${key}" value is not a valid trait type`,
        );
      }
    }

    return validTraits;
  }

  /**
   * Returns an array of all of the NFTs the user
   * possesses across all networks and accounts.
   *
   * @param allNfts
   */
  #getAllNFTsFlattened = memoize((allNfts: MetaMaskState['allNfts'] = {}) => {
    return Object.values(allNfts).reduce((result: Nft[], chainNFTs) => {
      return result.concat(...Object.values(chainNFTs));
    }, []);
  });

  /**
   * Returns the number of unique NFT addresses the user
   * possesses across all networks and accounts.
   *
   * @param allNfts
   */
  #getAllUniqueNFTAddressesLength(
    allNfts: MetaMaskState['allNfts'] = {},
  ): number {
    const allNFTAddresses = this.#getAllNFTsFlattened(allNfts).map(
      (nft) => nft.address,
    );
    const uniqueAddresses = new Set(allNFTAddresses);
    return uniqueAddresses.size;
  }

  /**
   * @param allTokens
   * @returns number of unique token addresses
   */
  #getNumberOfTokens(allTokens: MetaMaskState['allTokens']): number {
    return Object.values(allTokens).reduce((result, accountsByChain) => {
      return result + sum(Object.values(accountsByChain).map(size));
    }, 0);
  }

  /**
   * Computes wallet composition traits from internalAccounts, which is always
   * available regardless of lock state (unlike keyrings).
   *
   * number_of_account_groups deduplicates BIP44 multichain accounts by their
   * entropy source and group index so that EVM + BTC + SOL addresses derived
   * from the same SRP slot count as one account group, matching what users see
   * in the Account Management UI.
   *
   * @param metamaskState
   */
  #getAccountCompositionTraits(
    metamaskState: MetaMaskState,
  ): Partial<MetaMetricsUserTraits> {
    const accountGroupKeys = new Set<string>();
    const hdEntropyIds = new Set<string>();
    let numberOfImportedAccounts = 0;
    let numberOfLedgerAccounts = 0;
    let numberOfTrezorAccounts = 0;
    let numberOfLatticeAccounts = 0;
    let numberOfQrHardwareAccounts = 0;

    for (const [accountId, account] of Object.entries(
      metamaskState.internalAccounts.accounts,
    )) {
      const keyringType = account.metadata?.keyring?.type;

      switch (keyringType) {
        case KeyringType.imported:
          numberOfImportedAccounts += 1;
          break;
        case KeyringType.ledger:
          numberOfLedgerAccounts += 1;
          break;
        case KeyringType.trezor:
          numberOfTrezorAccounts += 1;
          break;
        case KeyringType.lattice:
          numberOfLatticeAccounts += 1;
          break;
        case KeyringType.qr:
        case KeyringType.oneKey:
          numberOfQrHardwareAccounts += 1;
          break;
        default:
          break;
      }

      // BIP44 multichain accounts share an entropy source id and group index
      // across all chains (EVM, BTC, SOL, …). Deduplicating on that key gives
      // the count of account groups rather than individual chain addresses.
      const entropy: InternalAccount['options']['entropy'] =
        account.options?.entropy;

      if (
        entropy?.type === 'mnemonic' &&
        'id' in entropy &&
        'groupIndex' in entropy
      ) {
        accountGroupKeys.add(`${entropy.id}:${entropy.groupIndex}`);
        hdEntropyIds.add(entropy.id);
      } else {
        accountGroupKeys.add(accountId);
      }
    }

    return {
      [MetaMetricsUserTrait.NumberOfHDEntropies]: hdEntropyIds.size,
      [MetaMetricsUserTrait.NumberOfAccountGroups]: accountGroupKeys.size,
      [MetaMetricsUserTrait.NumberOfImportedAccounts]: numberOfImportedAccounts,
      [MetaMetricsUserTrait.NumberOfLedgerAccounts]: numberOfLedgerAccounts,
      [MetaMetricsUserTrait.NumberOfTrezorAccounts]: numberOfTrezorAccounts,
      [MetaMetricsUserTrait.NumberOfLatticeAccounts]: numberOfLatticeAccounts,
      [MetaMetricsUserTrait.NumberOfQrHardwareAccounts]:
        numberOfQrHardwareAccounts,
      // MetaMask enforces one paired device per hardware wallet type, so
      // "types in use" equals "distinct devices".
      [MetaMetricsUserTrait.NumberOfHardwareWallets]:
        (numberOfLedgerAccounts > 0 ? 1 : 0) +
        (numberOfTrezorAccounts > 0 ? 1 : 0) +
        (numberOfLatticeAccounts > 0 ? 1 : 0) +
        (numberOfQrHardwareAccounts > 0 ? 1 : 0),
    };
  }

  /**
   * Calls segment.identify with given user traits
   *
   * @see {@link https://segment.com/docs/connections/sources/catalog/libraries/server/node/#identify}
   * @param userTraits
   */
  #identify(userTraits: MetaMetricsUserTraits): void {
    if (!userTraits || Object.keys(userTraits).length === 0) {
      console.warn('MetaMetricsController#_identify: No userTraits found');
      return;
    }

    try {
      this.#submitSegmentAPICall('identify', {
        traits: userTraits,
      });
    } catch (err) {
      this.#captureException(err);
    }
  }

  /**
   * Validates the trait value. Segment accepts any data type. We are adding validation here to
   * support data types for our Segment destination(s) e.g. MixPanel
   *
   * @param value
   */
  #isValidTrait(value: unknown): boolean {
    const type = typeof value;

    return (
      type === 'string' ||
      type === 'boolean' ||
      type === 'number' ||
      this.#isValidTraitArray(value) ||
      this.#isValidTraitDate(value)
    );
  }

  /**
   * Segment accepts any data type value. We have special logic to validate arrays.
   *
   * @param value
   */
  #isValidTraitArray(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      (value.every((element) => {
        return typeof element === 'string';
      }) ||
        value.every((element) => {
          return typeof element === 'boolean';
        }) ||
        value.every((element) => {
          return typeof element === 'number';
        }))
    );
  }

  /**
   * Returns true if the value is an accepted date type
   *
   * @param value
   */
  #isValidTraitDate(value: unknown): value is Date {
    return Object.prototype.toString.call(value) === '[object Date]';
  }

  /**
   * Perform validation on the payload before sending to Segment.
   * Also examines the options to route and handle the event appropriately.
   *
   * @private
   * @param payload - properties to attach to event
   * @param options - options for routing and handling the event
   */
  #track(
    payload: SegmentEventPayload &
      Pick<SegmentSubmissionPayload, 'sensitiveProperties'>,
    options?: MetaMetricsEventOptions,
  ): Promise<void> {
    const {
      matomoEvent,
      // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31880
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    } = options || {};

    let excludeMetaMetricsId = options?.excludeMetaMetricsId ?? false;
    // This is carried over from the old implementation, and will likely need
    // to be updated to work with the new tracking plan. I think we should use
    // a config setting for this instead of trying to match the event name
    const isSendFlow = Boolean(payload.event.match(/^send|^confirm/iu));
    // do not filter if excludeMetaMetricsId is explicitly set to false
    if (options?.excludeMetaMetricsId !== false && isSendFlow) {
      excludeMetaMetricsId = true;
    }

    // The platform adapter reads the "anonymous" marker from track `properties`
    // and swaps the user id for the shared anonymous id when marked is true.
    if (excludeMetaMetricsId) {
      (payload.properties as Record<string, Json>)[ANONYMOUS_EVENT_PROPERTY] =
        true;
    }

    if (matomoEvent === true) {
      payload.properties.legacy_event = true;
    }

    // Promises will only resolve when the event is sent to segment. For any
    // event that relies on this promise being fulfilled before performing UI
    // updates.
    return new Promise<void>((resolve, reject) => {
      const callback = (err: unknown) => {
        if (err) {
          const message = isErrorWithMessage(err) ? err.message : '';
          const stack = isErrorWithStack(err) ? err.stack : undefined;
          // The error that segment gives us has some manipulation done to it
          // that seemingly breaks with lockdown enabled. Creating a new error
          // here prevents the system from freezing when the network request to
          // segment fails for any reason.
          const safeError = new Error(message);
          if (stack) {
            safeError.stack = stack;
          }
          return reject(safeError);
        }
        return resolve();
      };

      this.#submitSegmentAPICall('track', payload, callback);
    });
  }

  /**
   * Method below submits the request to analytics SDK.
   * It will also add event to controller store
   * and pass a callback to remove it from store once request is submitted to segment
   * Saving segmentApiCalls in controller store in MV3 ensures that events are tracked
   * even if service worker terminates before events are submitted to segment.
   *
   * @param eventType - The type of event to track
   * @param payload - The payload to track
   * @param callback - The callback to call when the event is submitted
   */
  #submitSegmentAPICall(
    eventType: SegmentEventType,
    payload: SegmentSubmissionPayload,
    callback?: (result: unknown) => unknown,
  ): void {
    const { useExternalServices } = this.messenger.call(
      'PreferencesController:getState',
    );
    if (!useExternalServices) {
      // If basic functionality is disabled, we block all events.
      return;
    }

    const { latestNonAnonymousEventTimestamp } = this.state;
    const { analyticsId, optedIn } = this.#analyticsGetState();
    const userOptedOut = !optedIn || analyticsId.length === 0;
    const isMetricsOptOutEvent =
      payload.event === MetaMetricsEventName.MetricsOptOut;
    const isFireFox = getPlatform() === PLATFORM_FIREFOX;
    const shouldTrackMetricsOptOutEvent = isMetricsOptOutEvent && !isFireFox;
    const shouldRestoreOptOutAfterTracking =
      shouldTrackMetricsOptOutEvent && !optedIn;

    // Block events when user opted out. Exception: MetricsOptOut events are still sent on
    // non-Firefox browsers to record the opt-out action (Firefox privacy policies prohibit this).
    if (userOptedOut && !shouldTrackMetricsOptOutEvent) {
      return;
    }

    // TODO: Fix in https://github.com/MetaMask/metamask-extension/issues/31880
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const messageId = payload.messageId || generateRandomId();
    let timestamp = new Date();
    if (payload.timestamp) {
      const payloadDate = new Date(payload.timestamp);
      if (isValidDate(payloadDate)) {
        timestamp = payloadDate;
      }
    }

    const modifiedPayload = {
      ...payload,
      messageId,
      timestamp,
    };

    const propertiesAsRecord = modifiedPayload.properties as
      | Record<string, Json>
      | undefined;

    // Anonymization is decided in `#track` via this property.
    const isAnonymizedEvent =
      propertiesAsRecord?.[ANONYMOUS_EVENT_PROPERTY] === true;
    this.update((state) => {
      state.latestNonAnonymousEventTimestamp = isAnonymizedEvent
        ? latestNonAnonymousEventTimestamp
        : timestamp.valueOf();

      const persistedPayload = {
        ...modifiedPayload,
        timestamp: modifiedPayload.timestamp.toString(),
      };
      if (
        persistedPayload.sensitiveProperties &&
        Object.keys(persistedPayload.sensitiveProperties).length === 0
      ) {
        delete persistedPayload.sensitiveProperties;
      }

      const segmentApiCalls = state.segmentApiCalls as Record<
        string,
        {
          eventType: SegmentEventType;
          payload: SegmentSubmissionPayload & { timestamp: string };
        }
      >;
      segmentApiCalls[messageId] = {
        eventType,
        payload: persistedPayload as SegmentSubmissionPayload & {
          timestamp: string;
        },
      };
    });

    const modifiedCallback = (result: unknown) => {
      this.update((state) => {
        delete state.segmentApiCalls[messageId];
      });
      return callback?.(result);
    };

    const invocationOptions: AnalyticsInvocationOptions = {
      messageId,
      timestamp,
      callback: modifiedCallback,
    };
    if (modifiedPayload.context) {
      invocationOptions.context = modifiedPayload.context;
    }

    // The published `@metamask/analytics-controller` does not yet accept the
    // `options` argument on track/trackView/identify (PR MetaMask/core#8701
    // adds it). Cast to `unknown` first to forward the third argument while
    // keeping the existing call sites typed; remove this cast once #8701 is
    // released.
    const messengerCall = this.messenger.call.bind(this.messenger) as (
      action: string,
      ...args: unknown[]
    ) => unknown;

    if (eventType === 'identify') {
      const { traits } = modifiedPayload;
      messengerCall(
        'AnalyticsController:identify',
        traits as AnalyticsUserTraits,
        invocationOptions,
      );
      return;
    }

    if (eventType === 'page') {
      const name = modifiedPayload.name ?? '';
      const properties = modifiedPayload.properties as
        | Record<string, Json>
        | undefined;
      messengerCall(
        'AnalyticsController:trackView',
        name,
        properties,
        invocationOptions,
      );
      return;
    }

    const eventName = modifiedPayload.event ?? '';
    const trackProperties = (modifiedPayload.properties ?? {}) as Record<
      string,
      Json
    >;
    const sensitiveProps = modifiedPayload.sensitiveProperties ?? {};
    const hasProperties =
      Object.keys(trackProperties).length > 0 ||
      Object.keys(sensitiveProps).length > 0;

    if (shouldRestoreOptOutAfterTracking) {
      this.messenger.call('AnalyticsController:optIn');
    }

    try {
      messengerCall(
        'AnalyticsController:trackEvent',
        {
          name: eventName,
          properties: trackProperties,
          sensitiveProperties: sensitiveProps,
          hasProperties,
        },
        invocationOptions,
      );
    } finally {
      if (shouldRestoreOptOutAfterTracking) {
        this.messenger.call('AnalyticsController:optOut');
      }
    }
  }

  /**
   * Returns the total number of Ethereum addresses with saved petnames,
   * including all chain ID variations.
   *
   * @param metamaskState
   */
  #getPetnameAddressCount(metamaskState: MetaMaskState): number {
    const addressNames = metamaskState.names?.[NameType.ETHEREUM_ADDRESS] ?? {};

    return Object.keys(addressNames).reduce((totalCount, address) => {
      const addressEntry = addressNames[address];

      const addressNameCount = Object.keys(addressEntry).reduce(
        (count, chainId) => {
          const hasName = Boolean(addressEntry[chainId].name?.length);
          return count + (hasName ? 1 : 0);
        },
        0,
      );

      return totalCount + addressNameCount;
    }, 0);
  }
}
