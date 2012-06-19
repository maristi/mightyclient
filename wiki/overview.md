# MightyClient Overview #

MightyClient is a set of modules that allow you to have on the client side a JSON-like data structure synchronized in real-time with the server through the mechanism of optimistic concurrency. Optionally, a schema can be defined that will be enforced by run-time checks.

MightyClient is implemented on the client side in Closure Compiler-annotated Javascript, and on the server side as a module for Python version of App Engine.

For details not covered in this document, you can refer to the well-documented source code, the demo app and the unit tests.

The code is licensed under Apache 2.0 license.


## Structure ##

The four main modules are as follows:

- Datasource (server): `server/mc/datasource.py`,

- Channel (server): `server/mc/channel.py`,

- Channel (client): `client/mc/channel.js`,

- Datasource (client): `client/mc/datasource.js`.

The two Channel modules form an independent component at the bottom of the stack. They define a two-way communication channel between the client and the server that supports sharing of the channel by multiple "services". In addition to adding the forward (client-to-server) channel and the notion of services to the standard App Engine API, the Channel modules take care of reconnecting clients after App Engine socket expires, and buffering messages to memcache for clients that are in the process of connecting or re-connecting.

As a result of this four-module structure,

- The App Engine channel, via services mechanism, can be used for things not related to datasource;

- The two Channel modules can be used as a stand-alone tool;

- One can develop implementation for a platform other than App Engine by replacing all modules but the last one. Since that last module is what your application code talks to, the application code will not need to be changed.

We'll organize this document by module, though in a different order. The first two sections below deal with channel, the remaining two deal with the datasource.


## Channel: Client ##

Channel is represented on the client by `mc.GaeChannel` class that implements `mc.Channel`. With `registerService` method, you can register a service name, which can be any string (except the name of the system service discussed below), and associated handler of incoming messages. You can send messages to the server by calling `send` method. When you send messages to the server, the actual XHR request is postponed until the next batch of browser event processing, so messages sent in the same batch will be chunked together. There is one XHR going at a time: messages sent while we're waiting for the XHR to complete are buffered.

Under the hood `mc.GaeChannel` dog-foods its own functionality by using a special service whose name is `'system'` to exchange system messages with the server, such as getting GAE Channel token. After instantiating the channel, you can start calling `send` method right away, but at some point it is necessary to call `openBackwardChannel` method to open the GAE socket. What this method does is it sends request for token over system service.

If connection to the server is lost, the channel will put itself into suspended state and will dispatch `mc.Channel.EventType.SUSPENDED_CHANGE` event. To try reconnecting, call `unsuspend` method.


## Channel: Server ##

On the server you need to define one or more subclasses of `service.Service` class in `appengine_config.py`, the standard App Engine module configuration file. For full details, see `channel._ConfigDefaults` class in `channel.py`. Here is a sample `appengine_config.py`:

        from mc.service import Service


        class EchoService(Service):
          def handle_message(self, payload):
            # Echoes the message to the client who sent it.
            self.send(payload)


        class HelloService(Service):
          def handle_message(self, payload):
            # When one client sends another's ID,
            # says hello to that other client.
            self.send('Hello!', client_id=payload)


        mc_channel_SERVICES = [
          ('echo', EchoService),
          ('hello', HelloService),
        ]

Much like it happens with HTTP request handlers, when a message is received from a client, we instantiate the corresponding `Service` (with service name being analogous here to URL - we choose the first service in the services list whose associated regular expression matches the service name) and call its `handle_message` method like we would call `get` method of a request handler. The `Service` instance has properties that allow handlers to access the ID of the client and the service name.

Messages can be sent to a client by calling the `send` method of a `Service` instance or by calling the function `channel.send`. These two ways are equivalent, except that the instance method provides default values for arguments `client_id` and `service`.

The channel accepts both regular functions and NDB tasklets as callbacks. This means that if in a single XHR request the client sends messages via multiple services, these messages can be processed on the server asynchronously.

Messages can be delivered from server to client in two ways: by sending a GAE Channel message, and by sending the data in the response to a forward channel request. We use last method if on a given server, we are currently processing a forward channel request from the client to whom the message is sent. Also if the size of the message exceeds the limit of the GAE Channel API, instead of sending the message we send an instruction to the client to pick it up from memcache by making a forward channel request.

If `TRACK_PRESENCE` configuration parameter is set to `True`, we will track the presence of clients, meaning record connections and disconnections in memcache, and if the client is either in the process of opening the channel for the first time, or re-opening it after the GAE Channel API two-hour limit expires, we will buffer into memcache the messages that would otherwise have been sent via GAE Channel. The messages are delivered if and when the client is connected. Also, when the client is permanently disconnected and the server attempts to send a message to it, we will call the `handle_disconnected` callback of the `Service`, providing a convenient hook for clean-ups. Whichever the `TRACK_PRESENCE` setting, you can attach callbacks to `/_ah/channel/[dis]connected/` requests directly by using configuration variables `CONNECTED_HANDLERS` and `DISCONNECTED_HANDLERS`.

Messages in either direction are not guaranteed to be always delivered, or not to be delivered multiple times.


## Datasource: Client ##

### Initialization and client-server communication ###

The data is structured hierarchically, and at the root of the hierarchy is a `mc.ds.RootNode` instance. You start by instantiating `RootNode` (the arguments you pass to the constructor is the channel that should be used to communicate with the server, and the service name). Then you call the root node's `connect` method so that it would load from the server the initial state and would subscribe to updates. Once it's done, the root node will dispatch `INITIALIZED` event via an event target accessible with `getEventTarget` method. You cannot access the data before the datasource has been initialized. The initialization status is readable with `isInitialized` method.

When you set a value (we'll deal with specifics of data access API later), the following sequence of events will be triggered:

- in the next cycle of browser event processing (or possibly later, if you are controlling this behavior manually with methods `holdHorses`, `releaseHorses`, and `areHorsesHeld`), the updates will be sent to the server. At this point `SAVED_STATUS_CHANGE` event is dispatched and the method `areChangesSaved` will start returning False.

- Once the updates have been sent to the server, we wait to receive message from the server saying which updates have been committed in-memory and which ones weren't. If there is a mid-air collision with changes made by another client (this is discussed in more detail in the section on consistency groups) or if for some other reason the changes could not be committed, they will be rolled back and `ROLLBACK` event will be dispatched.

- Assuming the changes were successfully committed in-memory, a little later the server will let us know whether they have been successfully saved to disk. Whether the changes were saved or not, `SAVED_STATUS_CHANGE` will be dispatched the second time, and `areChangesSaved` will start returning `True`. If the changes were not saved on disk, then like in the case of mid-air collisions, the data tree will be rolled back and `ROLLBACK` event will be dispatched.

If internet connection is lost, the channel will suspend itself and dispatch the corresponding event, but the datasource will not dispatch any events and will reconnect to the server once the channel is unsuspended. However if there is a server error that cannot be remedied by rolling back unsaved data, or if despite the channel being connected, the server doesn't respond within some timeout, the datasource will dispatch an `ERROR` event, in which case you should dispose it, perhaps asking the user to reload the page.

Messages sent from the server may never reach the client, resulting in outdated state of the data on the client. To prevent the client state from lagging too far behind, root node checks in periodically with the server at the rate determined by `mc.ds.RootNode.MIN_CHECK_DELAY` and `mc.ds.RootNode.MAX_CHECK_DELAY` constants, by default set at 1 and 2 minutes respectively. The reason why the delay before we make the check has upper and lower bound is that this way when there are multiple `RootNode` instances on the client, they will chunk their checks together into a single XHR request.


### Accessing Data ###

The data is structured as a tree whose leafs are primitive values of the following types:

- `'Number'`: Values are numbers other than NaN and Infinity.

- `'Boolean'`: Values are booleans.

- `'String'`: Values are strings.

- `'Date'`: Values are instances of goog.date.Date but not goog.date.DateTime.

- `'Datetime'`: Values are instances of goog.date.DateTime.

- `'Json'`: Values are anything that can be serialized to JSON.

(The string identifiers of types only become relevant in context the "Schema" section below.)

Each primitive value is stored at a path composed of string keys, which can currently be anything other than an empty string, `'.'`, `'$'` and `'/'`. In some contexts a special `'*'` wildcard key can be used, signifying "any key".

We also use a concept of a data "node" (class `mc.ds.Node`, of which `mc.ds.RootNode` is a subclass), which is simply a combination of a reference to a root node and a fully qualified path from it. A node does not need to point to any existing data and disposing it will not affect the data. Node instances are created on-demand and cached when `getNode` method of another node is called. Nodes are used mainly for convenience and they also slightly optimize performance: when reading a node's descendant values and nodes, the path from root to the node does not have to be traversed.

Data is read using the node's methods `get` and `forEach` which do what you would expect. To set a primitive value, call `set` method. Instead of deleting a value, you set it to `null`.

When a primitive value changes, a `mc.ds.Change` event is dispatched (will discuss how to listen to these events in a moment). In addition to the path, old value and new value, the event object will have a property `source`, which will be one of the following:

- If the value was set on this client, the optional opt_source argument passed to `set` method or null if this argument was not provided;
- If the value changed because of an update sent from the server, `mc.ds.SERVER` token object;
- If the value changed because an update made on this client has been rolled back, `mc.ds.ROLLBACK` token object.

The `source` property is useful for objects such as user interface components that both listen to changes in a value and can modify the value. By providing a reference to itself as source when setting a value, and inspecting the source property when handling an event, the object can distinguish the events that it has itself triggered.

The same mechanism that is used internally for dispatching `mc.ds.Change` events is also available for dispatching any custom events whose scope is defined by a data tree path though the `RootNode`'s method `dispatchEvent`.

To listen to events (either `mc.ds.Change` or custom), call the node's `listen` method which returns an object that should be disposed to stop listening. It is convenient to attach those objects to disposables with `registerDisposable` method.

Normally you would dispatch custom events for paths which never point to primitive values (when schema is enabled, this is enforced by assertions). Suppose at paths `1/a`, `2/a`, ... you have primitive values x1, x2, ..., and you want to track a dynamically calculated `yN = xN + 1`. You can listen to path `*/a`, and if a value changes at path say `3/a`, you would catch the corresponding change event and will dispatch a custom event for path `3/b`. `b` here is a bit similar to event type in the standard events framework.

Note also that `dispatchEvent` accepts wildcard paths. Returning to the previous example, suppose instead of `yN = xN + 1` you have `yN = xN + z`. When `z` changes, causing all values `y1`, `y2`, ... to change, you can dispatch a custom event for path `*/b`. This event will be caught by listeners to paths such as `1/b`, `2/b`, or `*/b`.

Performance of event dispatcher depends only on the number of matching listeners when events are dispatched for fully qualified paths, but may be affected by the number of non-matching listeners when events are dispatched for wildcard paths.


### Consistency Groups ###

When you set a primitive value at some path, the update is guaranteed to be applied on other clients over the same original value at that path. If by the time the update is received by the server, the version of the value on the server is later than the version that the client had before it made the update, the update will be rolled back.

Sometimes you need a similar guarantee, but for a group of values instead of a single value. Suppose you have strings at paths `a0/a1`, `a0/b1`, `a0/c1` etc., and you want to allow the users to modify these strings, but you want to make sure that all strings are always different. Just checking that all the strings are different whenever a user makes a change is not enough: at the same time two users can set strings at two different paths to the same value, the check will pass when each change is made but once the data is synced, you will end up having the same string at two paths.

To prevent this, you can use a "consistency group", which is a group of primitive values such that the updates are guaranteed to be only applied on other clients over the same state of the entire group. Roots of consistency groups are marked by special `#` path elements. It works as follows: if the path to a primitive value does not contain any `#` keys, it is considered to be a consistency group of its own. If the path does contain one or more such keys, the path up to the last of these keys will identify the consistency group that the value belongs to. In above example, all you would need to do is instead of paths `a0/a1`, `a0/b1`, etc., use paths `a0/#/a1`, `a0/#/b1`, etc.

Instead of using a consistency group, you could have put all the strings into an object stored as a single primitive value of type Json. The case when it is a good idea to use consistency groups is when you want data consistency across a group of values, but prefer the change events to be still dispatched for each individual value.


### Transactions ###

To apply a set of updates that should either succeed completely or fail completely, pass a function that (synchronously) makes the updates to the method `inTransaction` of `RootNode`. Transactions can span multiple consistency groups.


### Minification ###

Minification of data tree keys is not fully implemented yet, but the plan is to do it in pretty much the same way as `goog.getCssName`. This will make both the javascript and the data sent over the wire smaller. There are functions `mc.ds.getName` and `mc.ds.setNameMapping` so that one can already write code ready for minification, what's missing is a compiler plugin that will replace calls to `mc.ds.getName` with minified keys.


### Schema ###

To make changes in the schema between versions of the application easy, the datasource is schema-less in the sense that primitive values are stored with type information attached to them. However for the purposes of documentation and testing, the client code can optionally define a schema that will be enforced by run-time assertions. When the code is compiled with `mc.ds.ENABLE_SCHEMA` set to `false`, both schema definitions and run-time schema checks will be stripped away by the compiler. Like `goog.asserts.ENABLE_ASSERTS`, `mc.ds.ENABLE_SCHEMA` is set to `goog.DEBUG` by default.

The schema is defined by calling `mc.ds.defineType` function. Each call to this function defines a "type". A type is a string with which there is associated a tree structure containing descendant types - either primitive types listed in section "Accessing Data" above, or other custom types, or a special type `'EventPath'` which is discussed below. If type `A` has type `B` at some path `x/y/z` in its schema tree, this means that any data tree element of type `A` must have a descendant data tree element of type `B` at relative path `x/y/z`.

The other thing you need to do is set the type of the root node. This is done by calling method `mc.ds.setType`, usually immediately after instantiating the root node. If the type of the root node is not set, no schema checks will be made for it.

`'EventPath'` mentioned above is a special type which marks paths at which no value can be stored but which (are the only paths that) can be used to dispatch custom events.

The keys in the schema trees should not be minified: mc.ds.getName is called on them automatically.

Schema types live in a global namespace, so it's recommended to prefix them in the same way as javascript names.


## Datasource: Server ##

### Configuration ###

To use MightyClient, you would need to configure the App Engine application as follows:

- Python 2.7 is required.

- Add the server-side modules to your app, for example by placing `server/mc/` directory to the root of your application directory, and have them handle some of the requests like so (this is an extract from app.yaml):

        - url: /mc_channel.*
          script: server.mc.channel.app

        - url: /_ah/channel/(connected|disconnected)/
          script: server.mc.channel.app

        - url: /mc_datasource.*
          script: server.mc.datasource.app

- Channel Presence service and webapp2 library are required:

        inbound_services:
        - channel_presence

        libraries:
        - name: webapp2
          version: "2.5.1"

The only other thing you need to do is to essentially publish a datasource, defined by a datastore key that serves as the root of the entity group where datasource keeps all its data. The way you do that is exemplified by the appengine_config.py of the demo app:

        from google.appengine.ext import ndb
        from server.mc.datasource import DatasourceService

        class DemoDatasource(DatasourceService):
          def __init__(self, name, client_id):
            super(DemoDatasource, self).__init__(name, client_id)
            self.datasource_key = ndb.Key('Datasource', name)
            self.access_mode = 'rw'

        mc_channel_SERVICES = [
          ('demo/.*', DemoDatasource),
        ]

Remember the `channel.Service` class from "Channel: Server" section above? Server-side functionality is implemented as a subclass `datasource.DatasourceService` of that class. What you do is you define your own service of a particular kind, a 'datasource service', by subclassing `datasource.DatasourceService`. The one thing you need to add in your implementation is you should override constructor to do three things, in any order:

- Call the constructor of the superclass.

- Set the root key of the datasource, `self.datasource_key`. The arguments passed to the constructor are service name (some string that matched the regex you specified in mc_channel_SERVICES), and ID of the client. In the example above the service name is used as string id of the datastore key. Another variable you may use to construct the key is ID of the user returned by the Users API.

- Set the access mode, `rw` for read-write, `r` for read-only. If access mode is not set, or set to `None`, the client will not be able to access any data.

You can have multiple subclasses of `datasource.DatasourceService` serving different services.


### Under the Hood ###

The main idea behind the server-side logic of the datasource is that when you can roll back changes on the client, you can optimistically assume that channel won't loose any messages, memcache will not have any items evicted, saving will be successfully initiated via Urlfetch service, datastore transaction will succeed, and if a failure does happen, you will roll back the state to the version on disk. The clients will not be told that changes have been saved until they have actually been written do disk.

When an update is received from the client, it is applied in-memory, sent out to other clients, and if a transaction that writes data to disk is not in progress, it is started. When that transaction completes, it checks if the in-memory state has changed, and if necessary starts another transaction. Thus only one transaction per datasource is going on at a time, the maximum number of updates per second is determined by the speed of memcache service, and the longest any client has to wait for its changes to be saved is the time it takes to save a transaction times 2.

We assign a version number to each update that was made, i.e. increment the version each time a value was set. These numbers are consecutive, and are used for bookkeeping when communicating with clients.

The versions are also used when working with memcache. The in-memory state is represented by a single memcache item; when we need to update it, we use compare-and-set. But instead of keeping all unsaved updates in this memcache value, we only keep in it the updates that make up the last transaction. Each time we need to save in memcache a new transaction, we replace the previous transaction with the new one. As for the transaction that was swapped out, we save the updates from that transaction as separate memcache items that have version numbers embedded in their keys. Since versions are consecutive, if any of these items gets evicted before we save them to disk, we will notice this and roll back the uncommitted changes.

Finally, one other trick we use is whenever we have to initialize in memcache the above-mentioned value that represents the in-memory state, we generate a random string, the so-called "in-memory state token", and add this token to the state before adding the state to memcache. Without going into specifics, this is used to handle a situation where the state memcache value gets evicted.
