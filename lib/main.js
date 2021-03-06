var data = require('sdk/self').data;
var self = require("sdk/self");
var simpleStorage = require('sdk/simple-storage');
var pageMod = require("sdk/page-mod");
var pageWorker = require("sdk/page-worker");
var tabs = require("sdk/tabs");
var system = require("sdk/system");

// Keeps track of all the workers that pass messages from here (main.js,
// the main addon) to the contentScripts (they do the work directly touching
// the browser.)
var workerList = [];
var crawledUrls = [];

function endsWith(str, suffix) {
    return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

function detachCrawler(parentWorker, url, crawlerDict){
    var index = crawlerDict.indexOf(url);
    if(index != -1) {
        crawlerDict.splice(index, 1);
    }
    if (crawlerDict.length < 1){
        // list is empty, signal crawling is over
        // TODO: this would be more efficient to only send the ones that were updated
        parentWorker.port.emit('allcrawlscomplete', fetchTableData());
    }
}

function detachWorker(worker, workerArray) {
    var index = workerArray.indexOf(worker);
    if(index != -1) {
        workerArray.splice(index, 1);
    }
}

// Initialize the storage if none exists
if (!simpleStorage.storage.ficdict)
    simpleStorage.storage.ficdict = {};

if (!simpleStorage.storage.prefs)
    // autofilter is enabled by default
    simpleStorage.storage.prefs = {
        'autofilter': true, 
        'tags': [], 
        'last_sync':0, 
        'sync_enabled':true
    };

// from
// http://stackoverflow.com/questions/6229197/how-to-know-if-two-arrays-have-the-same-values
function arrayCompare(array1, array2){
    return JSON.stringify(array1.sort()) === JSON.stringify(array2.sort());
}


function handleNewFic(metadata, mutable_data, is_private) {
/* Take in the data and rating, and store or update as necessary. Returns
   the new object.
*/
    if (!metadata['ao3id']){
        // Must have a vailid ID!
        return null;
    }
    var newArticle = new Article(metadata, mutable_data);
    if (!(newArticle.ao3id in simpleStorage.storage.ficdict)) {
        // If there's no mutable data coming in or the only mutable data coming in is a 
        // page view, and no old entry, skip it.
        if (!mutable_data){
            // No work changed - only view data, this is not in our DB
            return null;
        } else {
            //var mutable_keys = $.map(mutable_data, function(element,index) {return index});
            var mutable_keys = Object.keys(mutable_data);
            if (arrayCompare(mutable_keys, ['visit'])){
                // No work changed - crawled, ERROR sending visit data
                return null;
            }
        }
        saveArticle(newArticle, is_private);
    } else {
        // Update only
        updateArticle(simpleStorage.storage.ficdict[newArticle.ao3id], newArticle, is_private);
    }
    return simpleStorage.storage.ficdict[newArticle.ao3id];
}

function saveArticle(newArticle, is_private){
    if (!is_private){
        // TODO: this is a bug!  Why does it happen?
        if (newArticle['ao3id'] == 'undefined'){
            return;
        }
        simpleStorage.storage.ficdict[newArticle.ao3id] = newArticle;
        syncWork(newArticle);
    } else {
        // console.log('Private mode. Not saving.');
    }
}

function updateArticle(old_article, new_article, is_private){
/* Update an existing article.
       WARNING! MODIFIES the old_article!
       used by function handleNewFic
*/
    var currentTime = new Date().getTime() / 1000;
    if (is_private){
        // console.log('Private mode. Not saving.');
        return null;
    }
    // There will always be a crawled timestamp
    old_article.crawled = new_article.crawled;
    old_article.crawled__ts = new_article.crawled__ts;

    if (new_article.rating){
        // The dislike button is a special case, because it's value 
        // becomes "0" when we want to undo it.
        if (old_article.rating == -1){
            new_article.rating = 0;
        }
        old_article.rating = new_article.rating;
        old_article.rating__ts = new_article.rating__ts;
    }

    if (new_article.chapters){
        // If we found a new chapter, there was an update!
        if (new_article.chapters['published'] > old_article.chapters['published']){
            old_article.hasupdate = true;
            old_article.hasupdate__ts = currentTime;
        }
        old_article.chapters = new_article.chapters;
        old_article.chapters__ts = new_article.chapters__ts;
    }

    if (new_article.visit){
        old_article.visit = new_article.visit;
        old_article.visit__ts = new_article.visit__ts;
        // Clear the hasupdate flag when you've visited
        old_article.hasupdate = false;
        old_article.hasupdate__ts = currentTime;
    }

    // Important! We need to always update these both together!
    if (new_article.read || !(old_article.read)) {
        old_article.read = new_article.read;
        old_article.read__ts = new_article.read__ts;
        old_article.chapter_id = new_article.chapter_id;
        old_article.chapter_id__ts = new_article.chapter_id__ts;
    }
    syncWork(old_article);
}

function Article(metadata, mutable_data) {
/* Article Object. As it gets stored in memory.
*/
    var currentTime = new Date().getTime() / 1000; // ms to seconds
    this.ao3id = metadata.ao3id;
    this.author = unescape(metadata.author);
    this.title = unescape(metadata.title);
    this.crawled = new Date().toJSON();
    this.crawled__ts = currentTime;
    this.updated = new Date(metadata.updated).toJSON();
    this.updated__ts = currentTime;
    this.chapters = metadata['chapters'];
    this.chapters__ts = currentTime;

    if (mutable_data) {
        this.rating = mutable_data['rating'];
        this.rating__ts = currentTime;
        this.read = mutable_data['chapters_read'] || 0;
        this.read__ts = currentTime;
        this.chapter_id = mutable_data['chapter_id'];
        this.chapter_id__ts = currentTime;
        this.visit = mutable_data['visit'];
        this.visit__ts = currentTime;
    }

}

function fetchTableData(){
/* Fetch all article data for the table.
*/
    return simpleStorage.storage.ficdict;
}

function exportData(){
    var out = {
        'article_data': fetchTableData(),
        'version': '1.0.0',
        'prefs': fetchPrefs(),
    };
    return out;
}

function fetchTableDataId(seenIds){
/* Fetch article data by list of IDs
*/
    var out = {};
    for (var i in seenIds) {
        if (seenIds[i] in simpleStorage.storage.ficdict) {
            out[seenIds[i]] = simpleStorage.storage.ficdict[seenIds[i]];
        }
    }
    return out;
}


function fetchPrefs(){
    return simpleStorage.storage.prefs;
}

function savePrefs(prefs){
    for (var key in prefs){
        simpleStorage.storage.prefs[key] = prefs[key];
    }
}

function fetchTags(){
    return fetchPrefs['tags'];
}

function saveTags(tags){
    savePrefs({'tags': tags.split(',')});
}
// Functions for listening to incomming message data

// All the scripts for running the settings page need are attached here because
// they're special snowflakes that do message passing to main.js
var settingsPage = tabs.on('ready', function(tab) {
    // Don't attach settings page workers unless it's the settings page!
    if (!endsWith(tab.url, 'ao3rdr/data/settings/index.html')) {
        return;
    }
    worker = tab.attach({
        contentScriptFile: [self.data.url('./jquery-1.11.2.min.js'),
                            self.data.url('./settings/jquery.tagsinput.js'),
                            self.data.url("./settings/articles-table.js"),
                            self.data.url('./spin.js'),],
        onAttach: function(worker) { 
            var outgoingData = {
                'images': toolbarImages,
                'data': fetchTableData(),
                'prefs': fetchPrefs(),
            };
            workerList.push(this);
            this.port.emit('attached', outgoingData);
            // Listen for tabs settings changes and save them
            this.port.on('tags', function(tags) {
                saveTags(tags);
            });
            this.port.on('prefs', function(prefs) {
                savePrefs(prefs);
            });
            var crawlfun = (function(parentWorker, port) {
                return function() {
                    var urls = crawlWorks(parentWorker);
                    if (urls) {
                        crawledUrls = urls;
                    } else {
                        // do nothing, because a crawl was not started in this thread,
                        ;
                    }
                };
            })(this, this.port);
            this.port.on('crawlrequest', function(port) {
                // pass in the parent "worker" that's generating it so we can pass
                // messages back
                crawlfun();
            });
            this.port.on('restorefrombackup', function(data){
                // Update the DB data
                var version = data['version'];
                var article_data = data['article_data'];
                // TODO: is this right?
                var is_private = require("sdk/private-browsing").isPrivate(this);
                for (var i in article_data){
                    saveArticle(article_data[i], is_private);
                }
                savePrefs(data['prefs']);
                // Note that this uses the same signal as the crawler. I think that's OK
                this.emit('allcrawlscomplete', fetchTableData());

            });
            this.port.on('exportdata', function(){
                var data = exportData();
                this.emit('exportcomplete', data);
            });
            // Cloud backup
            this.port.on('save-token', function(data){
                // Data is the token
                var res = validateAndSaveToken(data, this);
            });
            this.port.on('reveal-token', function(){
                var data = getUser();
                this.emit('token-revealed', data);
            });

        },
        // TODO: BUGFIX: why isn't onClose triggering?
        onClose: function() {
            // triggers on navigate away, not tab close?
            detachWorker(this, workerList);
        },
    });
    // In this scope, emit like this:
    //worker.port.emit('attached', 'cake');
});

// You need to pass resources to the contentScripts. Here are all the images
// used by the toolbar.
var toolbarImages = {
    'star-shadow': self.data.url('./images/star-shadow.svg'),
    'star-0': self.data.url('./images/star-0.svg'),
    'star-1': self.data.url('./images/star-1.svg'),
    'star-3': self.data.url('./images/star-3.svg'),
    'star-5': self.data.url('./images/star-5.svg'),
    'star-1-fill': self.data.url('./images/star-1-fill.svg'),
    'star-3-fill': self.data.url('./images/star-3-fill.svg'),
    'star-5-fill': self.data.url('./images/star-5-fill.svg'),
    'hidden': self.data.url('./images/hidden.svg'),
    'hidden-shadow': self.data.url('./images/hidden-shadow.svg'),
    'dislike': self.data.url('./images/dislike.svg'),
    'dislike-fill': self.data.url('./images/dislike-fill.svg'),
    'dislike-shadow': self.data.url('./images/dislike-shadow.svg'),
    'menu': self.data.url('./images/menu.svg'),
    'menu-shadow': self.data.url('./images/menu-shadow.svg'),
    'flag': self.data.url('./images/flag.svg'),
    'unread': self.data.url('./images/unread.svg'),
    'read': self.data.url('./images/read.svg'),
    'bookmark': self.data.url('./images/bookmark.svg'),
    'bookmark-fill': self.data.url('./images/bookmark-fill.svg'),
    'bookmark-shadow': self.data.url('./images/bookmark-shadow.svg'),
};

// Create a page mod
// It will run a script whenever a ".org" URL is loaded
// The script replaces the page contents with a message

// Modify the pages of AO3 to show the addon stuff. Also attaches the workers who
// do the message passing.
var setupAO3 = pageMod.PageMod({
    // TODO: get this pattern to match more specifically to the pages we're working on
    include: "http://archiveofourown.org/*",
    contentScriptWhen: 'ready',
    contentScriptFile: [data.url('jquery-1.11.2.min.js'),
                        self.data.url("./toolbar-ao3.js"),
                        self.data.url("./ao3lib.js"),],
    // We actually want this on any page load of the site
    onAttach: function(worker) {

        runSync();

        var outgoingData = {
            'images': toolbarImages,
            'prefs': fetchPrefs(),
            'platform': system.platform
        };
        worker.postMessage(outgoingData);
        workerList.push(worker);
        worker.on('detach', function () {
            detachWorker(this, workerList);
        });

        // This is duplicate code with generateCralwer
        worker.port.on('click', function(data) {
            // isPrivate should function on workers
            var is_private = require("sdk/private-browsing").isPrivate(this);
            newArticle = handleNewFic(data.metadata, data.mutable_data, is_private);
            worker.port.emit('update', newArticle);
        });

        worker.port.on('settingsclick', function() {
            var newTab = tabs.open(self.data.url('./settings/index.html'));
        });
        worker.port.on('doneprocessing', function(seenIds) {
            // Once it's done with it's initial page modifications, we want to
            // check if we've seen the id's before, and send back any we have
            // for updating.
            var outgoingData = fetchTableDataId(seenIds);
            // TODO: replace this with a bulk method
            for (var i in outgoingData){
                worker.port.emit('update', outgoingData[i]);
            }
        });
    }
});

// The crawler
var pageWorkers = require("sdk/page-worker");

// crawlier running on a list of urls, one at a time
// Let it be known that this is a little bit messy, you have to explicitly
// signal it with the 'restartcrawl' for it to run for the 2nd + urls.
function generateCrawler(parentWorker, urlList) {
    var worker = pageWorkers.Page({
        contentURL: urlList[0],
        contentScriptWhen: 'ready',
        contentScriptFile: [data.url('jquery-1.11.2.min.js'),
                            self.data.url("./crawler-ao3.js"),
                            self.data.url("./ao3lib.js"),],
        contentScriptWhen: "ready",
    });
    worker.port.on('crawlcomplete', function(data){
        var is_private = require("sdk/private-browsing").isPrivate(this);
        newArticle = handleNewFic(data.metadata, data.mutable_data, is_private);
        detachCrawler(parentWorker, urlList[0], crawledUrls);
        if (urlList.length < 1){
            worker.destroy();
            return;
        }
        worker.contentURL = urlList[0];
        worker.port.emit('restartcrawl');
        urlList.pop();
    });
}

function divyUp(inList, batches){
    // divys up the inList into n batches
    // can't have more batches than elements
    out = [];
    batches = Math.min(inList.length, batches);
    var batchSize = Math.floor(inList.length / batches);
    var extra = inList.length % batchSize;
    var prev = 0;
    for (var i=batchSize; i <= inList.length; i+= batchSize){
        // if there are extra, add one to the batch _and_ i, decrement extra
        if (extra > 0){
            i += 1;
            extra -= 1;
        }
        out.push(inList.slice(prev, i));
        prev = i;
    }
    return out;
}


var batchSize = 3;
// TODO: user configurable batch size

function crawlWorks(parentWorker){
    var works = fetchTableData();
    // Only crawl non-complete works
    var out = [];
    // if there's already a crawl in progress, DO NOT CRAWL,
    if (crawledUrls.length > 0) {
        // send the signal that the crawl is over, none were updated
        parentWorker.port.emit('allcrawlscomplete', null);
        return [];
    }
    for (var i in works){
        var data = works[i];
        if ((data.chapters['complete']) || (data.rating == -1)){
            continue;
        }
        var url = 'http://archiveofourown.org/works/' + data.ao3id;
        out.push(url);
    }
    if (out.length < 1) {
        // send the singal that the crawl is over, since no workers were made
        // this is the case of "nothing to crawl"
        parentWorker.port.emit('allcrawlscomplete', null);
    }
    var batches = divyUp(out, batchSize);
    for (var i in batches){
        generateCrawler(parentWorker, batches[i]);
    }
    return(out);
}


var Request = require("sdk/request").Request;

var backendUrl = 'https://boiling-caverns-2782.herokuapp.com/api/v1.0/';
// var backendUrl = 'http://0.0.0.0:5000/api/v1.0/';



function newUser(){
    var newUserId = Request({
        // Must be a post()
        url: backendUrl + "user",
        onComplete: function (response) {
            // Save user
            if (response.status == 201){
                var user_id = response.json['user_id'];
                savePrefs({'user_id': user_id});
            }
        }
    });

    newUserId.post();
}


function getUser(){
    var prefs = fetchPrefs();
    if (!('user_id' in prefs)){
        newUser(); // WARNING: this is async, will take some time to complete.
    }
    return prefs['user_id'];
}

function handleFicSync(newArticle){
    if (!(newArticle.ao3id in simpleStorage.storage.ficdict)) {
        // TODO: handle is_private correctly
        saveArticle(newArticle, false);
    } else {
        // Update only
        // TODO: handle is_private correctly
        updateArticle(simpleStorage.storage.ficdict[newArticle.ao3id], newArticle, false);
    }
    return simpleStorage.storage.ficdict[newArticle.ao3id];
}


function syncData(){
    // Grab all data
    var user_id = getUser();
    if ((!user_id) || (!fetchPrefs()['sync_enabled'])){
        return;
    }

    var data = exportData();

    var sendData = Request({
        // Must be a post()
        url: backendUrl + 'user/' + user_id + "/collection",
        content: JSON.stringify(data),
        contentType: 'application/json',
        onComplete: function (response) {
            // Merge data here
            console.log('syncdata ' + response.status + ' ' + response.json);
            if ((response.status == 200) || (response.status == 201)){
                var diff = response.json['diff'];
                // Iterate through the dictionary of changed articles and update our DB
                // the key is the work ID
                // Also contains the settings!
                for (var key in diff) {
                    if (diff.hasOwnProperty(key)) {
                        if (key == 'settings'){
                            // TODO: update the settings
                        } else if (key == 'user_id'){
                            ; // You can safely ignore
                        } else {
                            var article = diff[key];
                            if ('user_id' in article){
                                delete article['user_id'];
                            }
                            var art = handleFicSync(article);
                        }
                    }
                }
                savePrefs({'last_sync': new Date().getTime() / 1000});
            }
        }
    });
    sendData.post();
}

function runSync(){
    var prefs = fetchPrefs();
    if (prefs['sync_enabled']){
        // Don't sync too often
        var minSyncWait = 60 * 10;  // 10 Minutes for full sync
        if (Date.now() -  minSyncWait < prefs['last_sync']){
            return;
        }
        if (getUser()){
            syncData();
        }
    }
}

function syncWork(data){
    var user_id = getUser();
    if ((!user_id) || (!fetchPrefs()['sync_enabled'])){
        return;
    }

    var sendData = Request({
        // Must be a post()
        url: backendUrl + 'user/' + user_id + "/work/" + data['ao3id'],
        content: JSON.stringify(data),
        contentType: 'application/json',
        onComplete: function (response) {
            console.log('syncwork ' + response.status + ' ' + JSON.stringify(response.json));
            // Merge data here
            if ((response.status == 200) || (response.status == 201)){
                var diff = response.json['diff'];
                // Iterate through the dictionary of changed articles and update our DB
                // the key is the work ID
                // Also contains the settings!
                for (var key in diff) {
                    if (dictionary.hasOwnProperty(key)) {
                        var article = diff[key];
                        if ('user_id' in article){
                            delete article['user_id'];
                        }
                        handleFicSync(article);
                    }
                }
            }
        }
    });
    sendData.post();
}

function validateAndSaveToken(token, port){

    var checkToken = Request({
        // Must be a get()
        // user/<string:user_id>
        url: backendUrl + 'user/' + token,
        content: JSON.stringify(data),
        contentType: 'application/json',
        onComplete: function (response) {
            // Merge data here
            if ((response.status == 200) && ('user_id' in response.json)){
                savePrefs({'user_id': response.json['user_id'] });
                syncData();  // Do a fresh sync ASAP
                port.emit('token-saved', {'token_status': 'valid', 'data': fetchTableData()});
                return response.json['user_id'];
            }
            port.emit('token-saved', {'token_status': 'invalid'});
            return false;
        }
    });
    var res = checkToken.get();
    if (!res){
        return 'invalid';
    } else {
        // Save the new token
        savePrefs({'user_id': res });
        return 'valid';
    }
}
