import Environment from "../Environment";
import * as log from "loglevel";
import LimitStore from "../LimitStore";
import Event from "../Event";
import Database from "../services/Database";
import * as Browser from "bowser";
import {getConsoleStyle, once} from "../utils";
import Postmam from "../Postmam";
import MainHelper from "./MainHelper";
import ServiceWorkerHelper from "./ServiceWorkerHelper";
import SubscriptionHelper from "./SubscriptionHelper";
import EventHelper from "./EventHelper";
import {InvalidStateError, InvalidStateReason} from "../errors/InvalidStateError";
import AlreadySubscribedError from "../errors/AlreadySubscribedError";
import ServiceUnavailableError from "../errors/ServiceUnavailableError";
import PermissionMessageDismissedError from '../errors/PermissionMessageDismissedError';
import OneSignalApi from "../OneSignalApi";
import { Uuid } from '../models/Uuid';
import { NotificationPermission } from '../models/NotificationPermission';
import SdkEnvironment from '../managers/SdkEnvironment';
import { WindowEnvironmentKind } from "../models/WindowEnvironmentKind";
import AltOriginManager from "../managers/AltOriginManager";
import { AppConfig } from "../models/AppConfig";
import SubscriptionModalHost from '../modules/frames/SubscriptionModalHost';
import * as objectAssign from 'object-assign';
import CookieSyncer from '../modules/CookieSyncer';
import TestHelper from './TestHelper';

declare var OneSignal: any;


export default class InitHelper {

  static storeInitialValues() {
    return Promise.all([
                         OneSignal.isPushNotificationsEnabled(),
                         OneSignal.getNotificationPermission(),
                         OneSignal.getUserId(),
                         OneSignal.isOptedOut()
                       ])
                  .then(([isPushEnabled, notificationPermission, userId, isOptedOut]) => {
                    LimitStore.put('subscription.optedOut', isOptedOut);
                    return Promise.all([
                                         Database.put('Options', { key: 'isPushEnabled', value: isPushEnabled }),
                                         Database.put('Options', {
                                           key: 'notificationPermission',
                                           value: notificationPermission
                                         })
                                       ]);
                  });
  }

  /**
   * This event occurs after init.
   * For HTTPS sites, this event is called after init.
   * For HTTP sites, this event is called after the iFrame is created, and a message is received from the iFrame signaling cross-origin messaging is ready.
   * @private
   */
  static async onSdkInitialized() {
    // Store initial values of notification permission, user ID, and manual subscription status
    // This is done so that the values can be later compared to see if anything changed
    // This is done here for HTTPS, it is done after the call to _addSessionIframe in sessionInit for HTTP sites, since the iframe is needed for communication
    InitHelper.storeInitialValues();
    InitHelper.installNativePromptPermissionChangedHook();

    if (await OneSignal.getNotificationPermission() === NotificationPermission.Granted) {
      /*
        If the user has already granted permission, the user has previously
        already subscribed. Don't show welcome notifications if the user is
        automatically resubscribed.
      */
      OneSignal.__doNotShowWelcomeNotification = true;
    }

    if (navigator.serviceWorker &&
        window.location.protocol === 'https:' &&
        !(await SubscriptionHelper.hasInsecureParentOrigin())) {
          navigator.serviceWorker.getRegistration()
            .then(registration => {
              if (registration && registration.active) {
                MainHelper.establishServiceWorkerChannel(registration);
              }
            })
            .catch(e => {
              if (e.code === 9) { // Only secure origins are allowed
                if (location.protocol === 'http:' || SdkEnvironment.getWindowEnv() === WindowEnvironmentKind.OneSignalProxyFrame) {
                  // This site is an HTTP site with an <iframe>
                  // We can no longer register service workers since Chrome 42
                  log.debug(`Expected error getting service worker registration on ${location.href}:`, e);
                }
              } else {
                log.error(`Error getting Service Worker registration on ${location.href}:`, e);
              }
            });
    }

    MainHelper.showNotifyButton();

    if (Browser.safari && OneSignal.config.autoRegister === false) {
      OneSignal.isPushNotificationsEnabled(enabled => {
        if (enabled) {
          /*  The user is on Safari and *specifically* set autoRegister to false.
           The normal case for a user on Safari is to not set anything related to autoRegister.
           With autoRegister false, we don't automatically show the permission prompt on Safari.
           However, if push notifications are already enabled, we're actually going to make the same
           subscribe call and register the device token, because this will return the same device
           token and allow us to update the user's session count and last active.
           For sites that omit autoRegister, autoRegister is assumed to be true. For Safari, the session count
           and last active is updated from this registration call.
           */
          InitHelper.sessionInit({__sdkCall: true});
        }
      });
    }

    if (SubscriptionHelper.isUsingSubscriptionWorkaround() && !MainHelper.isContinuingBrowserSession()) {
      /*
       The user is on an HTTP site and they accessed this site by opening a new window or tab (starting a new
       session). This means we should increment their session_count and last_active by calling
       registerWithOneSignal(). Without this call, the user's session and last_active is not updated. We only
       do this if the user is actually registered with OneSignal though.
       */
      log.debug(`(${SdkEnvironment.getWindowEnv().toString()}) Updating session info for HTTP site.`);
      OneSignal.isPushNotificationsEnabled(isPushEnabled => {
        if (isPushEnabled) {
          return MainHelper.getAppId()
                          .then(appId => MainHelper.registerWithOneSignal(appId, null));
        }
      });
    }

    MainHelper.checkAndDoHttpPermissionRequest();
    OneSignal.cookieSyncer.install();
  }

  static installNativePromptPermissionChangedHook() {
    if (navigator.permissions && !(Browser.firefox && Number(Browser.version) <= 45)) {
      OneSignal._usingNativePermissionHook = true;
      // If the browser natively supports hooking the subscription prompt permission change event
      //     use it instead of our SDK method
      navigator.permissions.query({name: 'notifications'}).then(function (permissionStatus) {
        permissionStatus.onchange = function () {
          EventHelper.triggerNotificationPermissionChanged();
        };
      });
    }
  }

  static saveInitOptions() {
    let opPromises = [];
    if (OneSignal.config.persistNotification === false) {
      opPromises.push(Database.put('Options', {key: 'persistNotification', value: false}));
    } else {
      if (OneSignal.config.persistNotification === true) {
        opPromises.push(Database.put('Options', { key: 'persistNotification', value: 'force' }));
      } else {
        opPromises.push(Database.put('Options', { key: 'persistNotification', value: true }));
      }
    }

    let webhookOptions = OneSignal.config.webhooks;
    ['notification.displayed', 'notification.clicked', 'notification.dismissed'].forEach(event => {
      if (webhookOptions && webhookOptions[event]) {
        opPromises.push(Database.put('Options', {key: `webhooks.${event}`, value: webhookOptions[event]}));
      } else {
        opPromises.push(Database.put('Options', {key: `webhooks.${event}`, value: false}));
      }
    });
    if (webhookOptions && webhookOptions.cors) {
      opPromises.push(Database.put('Options', {key: `webhooks.cors`, value: true}));
    } else {
      opPromises.push(Database.put('Options', {key: `webhooks.cors`, value: false}));
    }

    if (OneSignal.config.notificationClickHandlerMatch) {
      opPromises.push(Database.put('Options', {
        key: 'notificationClickHandlerMatch',
        value: OneSignal.config.notificationClickHandlerMatch
      }));
    } else {
      opPromises.push(Database.put('Options', {key: 'notificationClickHandlerMatch', value: 'exact'}));
    }

    if (OneSignal.config.notificationClickHandlerAction) {
      opPromises.push(Database.put('Options', {
        key: 'notificationClickHandlerAction',
        value: OneSignal.config.notificationClickHandlerAction
      }));
    } else {
      opPromises.push(Database.put('Options', {key: 'notificationClickHandlerAction', value: 'navigate'}));
    }

    if (OneSignal.config.serviceWorkerRefetchRequests === false) {
      opPromises.push(Database.put('Options', {key: 'serviceWorkerRefetchRequests', value: false}));
    } else {
      opPromises.push(Database.put('Options', {key: 'serviceWorkerRefetchRequests', value: true}));
    }
    return Promise.all(opPromises);
  }

  static async internalInit() {
    log.debug('Called %cinternalInit()', getConsoleStyle('code'));
    const appId = await Database.get<string>('Ids', 'appId');

    // HTTPS - Only register for push notifications once per session or if the user changes notification permission to Ask or Allow.
    if (sessionStorage.getItem("ONE_SIGNAL_SESSION")
      && !OneSignal.config.subdomainName
      && (window.Notification.permission == "denied"
      || sessionStorage.getItem("ONE_SIGNAL_NOTIFICATION_PERMISSION") == window.Notification.permission)) {
      Event.trigger(OneSignal.EVENTS.SDK_INITIALIZED);
      return;
    }

    sessionStorage.setItem("ONE_SIGNAL_NOTIFICATION_PERMISSION", window.Notification.permission);

    if (Browser.safari && OneSignal.config.autoRegister === false) {
      log.debug('On Safari and autoregister is false, skipping sessionInit().');
      // This *seems* to trigger on either Safari's autoregister false or Chrome HTTP
      // Chrome HTTP gets an SDK_INITIALIZED event from the iFrame postMessage, so don't call it here
      if (!SubscriptionHelper.isUsingSubscriptionWorkaround()) {
        Event.trigger(OneSignal.EVENTS.SDK_INITIALIZED);
      }
      return;
    }

    if (OneSignal.config.autoRegister === false && !OneSignal.config.subdomainName) {
      log.debug('Skipping internal init. Not auto-registering and no subdomain.');
      /* 3/25: If a user is already registered, re-register them in case the clicked Blocked and then Allow (which immediately invalidates the GCM token as soon as you click Blocked) */
      Event.trigger(OneSignal.EVENTS.SDK_INITIALIZED);
      const isPushEnabled = await OneSignal.isPushNotificationsEnabled();
      if (isPushEnabled && !SubscriptionHelper.isUsingSubscriptionWorkaround()) {
        log.info('Because the user is already subscribed and has enabled notifications, we will re-register their GCM token.');
        // Resubscribes them, and in case their GCM registration token was invalid, gets a new one
        SubscriptionHelper.registerForW3CPush({});
      } else {
        ServiceWorkerHelper.updateServiceWorker();
      }
      return;
    }

    if (document.visibilityState !== "visible") {
      once(document, 'visibilitychange', (e, destroyEventListener) => {
        if (document.visibilityState === 'visible') {
          destroyEventListener();
          InitHelper.sessionInit({__sdkCall: true});
        }
      }, true);
      return;
    }

    InitHelper.sessionInit({__sdkCall: true});
  }

  // overridingPageTitle: Only for the HTTP Iframe, pass the page title in from the top frame
  static async initSaveState(overridingPageTitle: string) {
    const appId = await MainHelper.getAppId()
    await Database.put("Ids", { type: "appId", id: appId });
    const initialPageTitle = overridingPageTitle || document.title || 'Notification';
    await Database.put("Options", { key: "pageTitle", value: initialPageTitle });
    log.info(`OneSignal: Set pageTitle to be '${initialPageTitle}'.`);
  }

  static sessionInit(options) {
    log.debug(`Called %csessionInit(${JSON.stringify(options)})`, getConsoleStyle('code'));
    if (OneSignal._sessionInitAlreadyRunning) {
      log.debug('Returning from sessionInit because it has already been called.');
      return;
    } else {
      OneSignal._sessionInitAlreadyRunning = true;
    }

    var hostPageProtocol = `${location.protocol}//`;

    if (Browser.safari) {
      if (OneSignal.config.safari_web_id) {
        MainHelper.getAppId()
                 .then(appId => {
                   window.safari.pushNotification.requestPermission(
                     `${SdkEnvironment.getOneSignalApiUrl().toString()}/safari`,
                     OneSignal.config.safari_web_id,
                     {app_id: appId},
                     pushResponse => {
                       log.info('Safari Registration Result:', pushResponse);
                       if (pushResponse.deviceToken) {
                         let subscriptionInfo = {
                           // Safari's subscription returns a device token (e.g. 03D5D4A2EBCE1EE2AED68E12B72B1B995C2BFB811AB7DBF973C84FED66C6D1D5)
                           endpointOrToken: pushResponse.deviceToken.toLowerCase()
                         };
                         MainHelper.registerWithOneSignal(appId, subscriptionInfo);
                       }
                       else {
                         MainHelper.beginTemporaryBrowserSession();
                       }
                       EventHelper.triggerNotificationPermissionChanged();
                     }
                   );
                 });
      }
    }
    else if (options.modalPrompt && options.fromRegisterFor) { // If HTTPS - Show modal
      Promise.all([
        MainHelper.getAppId(),
        OneSignal.isPushNotificationsEnabled(),
        OneSignal.getNotificationPermission()
      ])
        .then(([appId, isPushEnabled, notificationPermission]) => {
          OneSignal.subscriptionModalHost = new SubscriptionModalHost({ appId: appId }, options);
          OneSignal.subscriptionModalHost.load();
        });
    }
    else if ('serviceWorker' in navigator && !SubscriptionHelper.isUsingSubscriptionWorkaround()) { // If HTTPS - Show native prompt
      if (options.__sdkCall && !MainHelper.wasHttpsNativePromptDismissed()) {
        Event.trigger(OneSignal.EVENTS.PERMISSION_PROMPT_DISPLAYED);
        window.Notification.requestPermission(permission => {
          MainHelper.checkAndTriggerNotificationPermissionChanged();
          if (permission === "granted") {
            SubscriptionHelper.registerForW3CPush(options);
          }
          else if (window.Notification.permission === "default") {
            EventHelper.triggerNotificationPermissionChanged(true);
            TestHelper.markHttpsNativePromptDismissed();
          }
        });
      } else if (options.__sdkCall && MainHelper.wasHttpsNativePromptDismissed()) {
        log.debug('OneSignal: Not automatically showing native HTTPS prompt because the user previously dismissed it.');
        OneSignal._sessionInitAlreadyRunning = false;
      } else {
        SubscriptionHelper.registerForW3CPush(options);
      }
    }
    else {
      if (OneSignal.config.autoRegister !== true) {
        log.debug('OneSignal: Not automatically showing popover because autoRegister is not specifically true.');
      }
      if (MainHelper.isHttpPromptAlreadyShown()) {
        log.debug('OneSignal: Not automatically showing popover because it was previously shown in the same session.');
      }
      if ((OneSignal.config.autoRegister === true) && !MainHelper.isHttpPromptAlreadyShown()) {
        OneSignal.showHttpPrompt().catch(e => {
          if (e instanceof InvalidStateError && ((e as any).reason === InvalidStateReason[InvalidStateReason.RedundantPermissionMessage]) ||
              e instanceof PermissionMessageDismissedError ||
              e instanceof AlreadySubscribedError) {
            log.debug('[Prompt Not Showing]', e);
            // Another prompt is being shown, that's okay
          } else throw e;
        });
      }
    }

    Event.trigger(OneSignal.EVENTS.SDK_INITIALIZED);
  }

  static getMergedLegacyConfig(userConfig: any, serverConfig: AppConfig): any {
    /**
     * How Object.assign() works: any hash property can be overriden by another
     * with the same name below it. The bottom-most hash properties are the most
     * final "source of truth".
     */
    const finalConfig = objectAssign({
      path: '/'
    }, {
        subdomainName: serverConfig.subdomain
      }, {
        safari_web_id: serverConfig.safariWebId
      }, {
        cookieSyncEnabled: serverConfig.cookieSyncEnabled
      },
      userConfig);

    // For users that do not specify a subdomainName but have one still assigned
    // in the dashboard, do not assign the dashboard-provided subdomain,
    // otherwise the site that may be intended for an HTTPS integration will
    // become HTTP-only
    if (!userConfig.subdomainName) {
      delete finalConfig.subdomainName;
    }

    return finalConfig;
  }
}
