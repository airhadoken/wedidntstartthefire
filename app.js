//var Rhyme = require("rhyme");
var Rita = require("rita");
var n2w = require("number-to-words");
Rita.RiTa.SILENT = true;
var https = require("https");
var MongoClient = require('mongodb').MongoClient;
var Q = require("q");
var Twit = require("twit");

var config = require("./config.json");

var say_letter = {
  A: "ay",
  B: "bee",
  C: "see",
  D: "dee",
  E: "ee",
  F: "eff",
  G: "gee",
  H: "aitch",
  I: "eye",
  J: "jay",
  K: "kay",
  L: "ell",
  M: "em",
  N: "en",
  O: "oh",
  P: "pee",
  Q: "cue",
  R: "arr",
  S: "ess",
  T: "tee",
  U: "you",
  V: "vee",
  W: "double you",
  X: "eks",
  Y: "why",
  Z: "zee"
};

function makespeakable(phrase) {
  phrase = phrase.replace(/['"]/g, "");
  phrase = phrase.replace(/[-+]/g, " ");
  phrase = phrase.replace(/([A-Z])(?=[A-Z])/g, "$1 ");    //split apart capitals
  phrase = phrase.replace(/([A-Za-z])([0-9])/g, "$1 $2"); // split letter-number
  phrase = phrase.replace(/([0-9])([A-Za-z])/g, "$1 $2"); // split number-letter
  return phrase.replace(/\b[A-Z](?=[[:space:][:punct:]])/g, function(match) {
    return say_letter[match.toUpperCase()];
  })
  .replace(/[0-9]+ (st|nd|rd|th)\b/g, function(match) {
    return n2w.toOrdinalWords(parseInt(match)).replace(/[-,]/g, " ");
  })
  .replace(/[0-9]+/g, function(match) {
    return n2w.toWords(match).replace(/[-,]/g, " ");
  });
}

function worddb(maxlength) {

  var words = [];
  var rhymecache = {};
  var syllcache = {};
  var wordrl = {};
  var dirty = [];
  maxlength = maxlength || 8;

  function indexword(word) {
    wordrl[word.word.toLowerCase()] = (wordrl[word.word.toLowerCase()] || 0) + 1;
    word.rhymekey.forEach(function(key, i) {
      var key_prefix = word.rhymekey.slice(0, i + 1).join(" ");
      rhymecache[key_prefix] = rhymecache[key_prefix] || [];
      rhymecache[key_prefix].push(word);
    });
    syllcache[(word.off ? "off" : "") + word.syllcount] = syllcache[(word.off ? "off" : "") + word.syllcount] || [];
    syllcache[(word.off ? "off" : "") + word.syllcount].push(word);
  }


  // Returns an array if at least one element in the source array
  //  matches each element in the spec array by the properties in the objects of spec.
  function sublistByProperty(arr, spec) {

    spec = spec.slice(0),
    speccount = spec.length;
    var sublist = new Array(speccount);
    arr.forEach(function(arrayel) {
      var success = false;
      if(arrayel.used) {
        return false;
      }
      if(spec.length < 1)
        return false; // already done
      spec.forEach(function(specel, i) {
        if(success || !specel)
          return;
        if(Object.keys(specel).reduce(function(current, spkey) {
          if(typeof specel[spkey] === "function") {
            return current && specel[spkey](arrayel[spkey], arrayel, sublist);
          } else {
            return current && specel[spkey] === arrayel[spkey];
          }
        }, true)) {
          // spec matched.  Remove it and mark success
          delete spec[i];
          speccount --;
          success = true;
          sublist[i] = arrayel;
        }
      });
    });
    if(speccount < 1) {
      return sublist;
    } else {
      return null;
    }
  }

  function sublistByBuckets(arr, buckets) {
    return sublistByProperty(arr, buckets.map(function(syll) {
      var result = {
        off: false,
        word: function(wordstr, wordfull, others) {
          var lastword = wordstr.split(" ");
          lastword = lastword[lastword.length - 1].toLowerCase();
          if(others.length < 1)
            return true;
          return others.map(function(word) {
            var lw = word.word.split(" ");
            lw = lw[lw.length - 1].toLowerCase();
            return lw;
          }).indexOf(lastword) === -1;
        }
      };
      if(~syll.indexOf("off")) {
        syll = syll.replace(/^.*off/, "");
        result.off = true;
      }
      result.syllcount = parseInt(syll);
      return result;
    }));
  }

  this.add = function(word) {
    var processedword, speakable, rs, syllables;
    if(wordrl[(word.word || word).toLowerCase()]) {
      return null;
    }

    if(typeof word === "string") {
      speakable = makespeakable(word);
      rs = Rita.RiTa.getStresses(speakable);
      syllables = Rita.RiTa.getSyllables(speakable).split(/[\/ ]/).reverse();
      rs = rs.replace(/[^01]/g, ""); 


      processedword = {
        word: word,
        timestamp: Date.now(),
        used: false,
        speak: speakable,
        syllcount: rs.length,
        off: rs[0] === "0",
        syllables: syllables,
        rhymekey: syllables.slice(
                    0, 
                    ~rs.lastIndexOf("1") ? (rs.length - rs.lastIndexOf("1")) : rs.length
                  ).map(function(syll) {
                    return syll.replace(/^[^aeiou]*/, "");
                  })
      };
      if(rs.length < 1 || rs.length > maxlength) {
        return;
      }
    } else {
      processedword = word;
    }

    if(processedword) {
      words.push(processedword);
      indexword(processedword);
    }
    return processedword;
  };

  this.rebuildcache = function() {
    rhymecache = {};
    syllcache = {};
    wordrl = {};
    words.forEach(function(word) {
      if(!wordrl[word.word]) {
        indexword(word);
      }
    });
  };

  this.getAllRhymes = function(patterns) {
    try {
      console.log(Object.keys(rhymecache).map(function(key) {
        return key + ": " + rhymecache[key].filter(function(k) { return !k.used; }).map(function(k) { return k.word}).join(", ");
      }).join("\n"));

      return Object.keys(rhymecache).reduce(function(current, rhymekey) {

        var rhymewords = rhymecache[rhymekey];
        var result = patterns.map(function(pattern) {
          var _result = sublistByBuckets(rhymewords, pattern);
          if(_result) {
            return { key: pattern, result: _result};
          } else {
            return null;
          }
        }).filter(function(res) {
          return !!res;
        });

        if(result.length > 0) {
          current[rhymekey] = result;
        }
        return current;
      }, {});
    } catch(e) {
      console.error(e.stack);
    }
  };

  this.getWord = function(bucket) {
    var cache = syllcache[bucket].filter(function(word) {
      return !word.used;
    });
    return cache[Math.floor(Math.random() * cache.length)];
  };

  this.nonEmptyBuckets = function(bucketspec) {
    return bucketspec.filter(function(bucket) {
      return ~Object.keys(syllcache).indexOf(bucket) &&
            syllcache[bucket].filter(function(word) {
              return !word.used;
            }).length > 0;
    });
  };

  this.markused = function() {
    var mongodb, that = this,
        args = [].slice.call(arguments, 0);
    args.forEach(function(arg) {
      if(!arg.used) {
        arg.used = true;
        dirty.push(arg);
      }
    });
    return this;
  };

  this.loadFromMongo = function() {
    var that = this, mongodb;
    return Q.nfcall(MongoClient.connect, config.mongodb_url).then(function(db) {
      var collection = db.collection(config.mongodb_collection);
      mongodb = db;
      return Q(collection.find({}).toArray());
    }).then(function(arr) {
      arr.forEach(function(item) {
        that.add(item);
      });
      return that;
    }).finally(function() {
      mongodb && mongodb.close();
    });
};

  this.getNewTrends = function() {
    var that = this;
    var url = "https://www.google.com/trends/hottrends/hotItems?ajax=1&pn=p1&htv=l";
    return Q.fcall(https.get, url).then(function(client) {
      var deferred = Q.defer();
      client.on("response", function(resp) {
        var body = "";
        resp.on('data', function(chunk) {
          body += chunk;
        });
        resp.on("end", function() {
          try {
            var json = JSON.parse(body);
            json.trendsByDateList.map(function(trenddate) {
              trenddate.trendsList.forEach(function(trend) {
                var newtrend = that.add(trend.title);
                if(newtrend) { // falsy if it's not new.
                  newtrend.isNew = true;
                }
              });
            });
            deferred.resolve(that);
          } catch(e) {
            console.error(e.stack);
            deferred.reject(e);
          }
        });
        resp.on("error", function(e) {
          deferred.reject(e);
        });
      });
      return deferred.promise;
    });
  };

  this.saveToMongo = function() {
    var that = this;
    var wordslist = words.filter(function(word) {
      var isNew = word.isNew;
      delete word.isNew;
      return isNew;
    });

    if(!wordslist.length && !dirty.length) {
      return Q(this);
    }
    var mongodb;
    return Q.nfcall(MongoClient.connect, config.mongodb_url).then(function(db) {
      var collection, del_dfd, ins_dfd, upd_dfd;
      mongodb = db;
      collection = db.collection(config.mongodb_collection);
      del_dfd = Q.nfcall(
        collection.deleteMany.bind(collection),
        { timestamp : { "$lt" : Date.now - 30 * 24 * 60 * 60 * 1000 }});
      if(wordslist.length) {
        ins_dfd = Q.nfcall(
          collection.insertMany.bind(collection),
          wordslist);
      }
      if(dirty.length) {
        upd_dfd = Q.nfcall(
          collection.updateMany.bind(collection),
          {_id: { $in : dirty.map(function(arg) { return arg._id; })}},
          {$set : { used: true }}
        ).then(function() {
          dirty = [];
        });
      }
      return Q.all([del_dfd, ins_dfd, upd_dfd]).then(function() {
        return db;
      });
    }).finally(function() {
      mongodb && mongodb.close();
    });
  };

  return this;

} 

function pluck(arr, query) {
  var candidates, cand;
  if(query) {
    candidates = arr.filter(function(item) {
      return Object.keys(query).reduce(function(currval, key) {
        var val = item[key];
        return currval && (val === query[key]);
      }, true);
    });

    cand = candidates[Math.floor(Math.random() * candidates.length)];
    arr.splice(arr.indexOf(cand), 1);
    return cand;
  } else {
    return arr.splice(Math.floor(Math.random() * arr.length), 1)[0];  
  }
}
Array.prototype.pluck = function(query) { return pluck(this, query); };

// Zip permutes two arrays, so for elements a in array A and b in array B,
//  the returned array will contain the array [a,b] as an element.
function zip(arr, brr) {
  return [].concat.apply([], arr.map(function(a) {
    return brr.map(function(b) {
      return [a, b];
    });
  }));
}

//  Non-setuppy code starts here.
var db = new worddb();
db.loadFromMongo().then(function(db) {
 return db.getNewTrends();
}).then(function(db) {
  var arhymes = zip(
    db.nonEmptyBuckets(["2", "3", "4"]), 
    db.nonEmptyBuckets(["2", "3", "4", "6", "7", "off3", "off4", "off6"])
  );
  var brhymes = zip(
    db.nonEmptyBuckets(["2", "3", "4"]), 
    db.nonEmptyBuckets(["2", "3", "4", "6", "7", "off3", "off4", "off5"])
  );
  var _word, aline, alinestr, bline, blinestr;

  if(db.nonEmptyBuckets(["7"]).length > 1) {
    arhymes = arhymes.concat([["7", "7"]]);
    brhymes = brhymes.concat([["7", "7"]]);
  }
  var rhyme_candidates = db.getAllRhymes(arhymes);

  var keys = Object.keys(rhyme_candidates).sort(function(a, b) {
    return a.length === b.length ? 0 : (a.length < b.length ? 1 : -1);
  });

  if(!keys.length) {
    return Q.reject("No rhyming words were found at all");
  }

  aline = rhyme_candidates[keys.shift()].pluck();
  if(!aline) {
    return Q.reject({stack: "No rhyme was found for A-pattern"});
  }
  db.markused.apply(db, aline.result);

  // now get a rhyme for line B
  rhyme_candidates = db.getAllRhymes(brhymes);

  keys = Object.keys(rhyme_candidates).sort(function(a, b) {
    return a.length === b.length ? 0 : (a.length < b.length ? 1 : -1);
  });

  if(!keys.length) {
    return Q.reject("No rhyming words were found for line B");
  }

  bline = rhyme_candidates[keys.shift()].pluck();
  if(!bline) {
    return Q.reject({stack: "No rhyme was found for B-pattern"});
  }
  db.markused.apply(db, bline.result);

  if(~["2", "3", "4", "off3", "off4"].indexOf(aline.key[1])) {
    _word = db.getWord(db.nonEmptyBuckets(["2", "3", "4"]).pluck());
    if(!_word) {
      return Q.reject({stack : "Could not find a word to push into X2 position, line A"});
    }
    aline.result.splice(1, 0, _word);
    db.markused(_word);
  } 
  if(~["2", "3", "4"].indexOf(aline.key[0])) {
    _word = db.getWord(db.nonEmptyBuckets(["2", "3", "4"]).pluck());
    if(!_word) {
      return Q.reject({stack : "Could not find a word to push into X1 position, line A"});
    }
    aline.result.unshift(_word);
    db.markused(_word);
  }
  alinestr = aline.result.reduce(function(curr, next, i) { 
    return (i ? curr + ", " : "") 
          + (next.off ? "and " : "")
          + next.word;
  }, "");
  if(~["2", "3", "4", "off3"].indexOf(bline.key[1])) {
    _word = db.getWord(db.nonEmptyBuckets(["1", "2", "3", "4"]).pluck());
    if(!_word) {
      return Q.reject({stack : "Could not find a word to push into X2 position, line B"});
    }
    bline.result.splice(1, 0, _word);
    db.markused(_word);
    if(bline.result[1].syllcount === 1) {
      _word = db.getWord("1");
      bline.result.splice(1, 0, _word);
      db.markused(_word);
    }
  } 
  if(~["2", "3", "4"].indexOf(bline.key[0])) {
    _word = db.getWord(db.nonEmptyBuckets(["2", "3", "4"]).pluck());
    if(!_word) {
      return Q.reject({stack : "Could not find a word to push into X1 position, line B"});
    }
    bline.result.unshift(_word);
    db.markused(_word);
  } 
  blinestr = bline.result.reduce(function(curr, next, i) { 
    return (i ? curr + ", " : "") 
          + (next.off ? "and " : "")
          + next.word;
  }, "");

  var T = new Twit({
    consumer_key:     config.consumer_key, 
    consumer_secret:  config.consumer_secret,
    access_token:     config.access_token,
    access_token_secret: config.access_token_secret
  });

  return Q.nfcall(T.post.bind(T), 'statuses/update', { status: alinestr + "\n" + blinestr }).then(function(reply) {
      console.log("reply: ", reply);    
    });
}).then(function() {
  console.log("save success.  finish process");
}, function(e) {
  console.error(e.stack || e);
  db.rebuildcache();
}).finally(function() {
  db.saveToMongo();
});

// trends.forEach(function(trend) {
//   db.add(trend);
// });
/*
var rhyme = db.makerhyme(["4", "3a", "3", "off3a"]);
console.log(rhyme.map(function(term) { return term && term.word || term; }));
rhyme = db.makerhyme(["2", "3a", "6a"]);
console.log(rhyme.map(function(term) { return term && term.word || term; }));
*/

function makerhymekey(phrase) {
  var i;
  var speak_phrase = makespeakable(phrase);
  var stresses = Rita.RiTa.getStresses(speak_phrase);
  stresses = stresses.replace(/[^01]/g, "");

  var syllables = Rita.RiTa.getSyllables(speak_phrase).split(/[\/ ]/).reverse();
  var num_syllables = ~stresses.lastIndexOf("1") ? (stresses.length - stresses.lastIndexOf("1")) : stresses.length;
  return syllables.slice(0, num_syllables).map(function(syll) {
    return syll.replace(/^[^aeiou]*/, "");
  }).join(" ");
}

return;

//  Some notes about the rhythmic structure of We Didn't Start the Fire:
//  The constructor for lyrics above doesn't perfectly match this,
//   because most of the original song uses 1010... stress patterns,
//   and we're only accounting for whether the first syllable is stressed (not "off")
//   or not stressed ("off").

// Here's what we can do, syllable-wise:
//  The two lines of the couplet are different.  Here's line A possibilities:
//  2, 2, 3, 6   <-- too specialized, don't worry about this one
//  2, 2,    4, 2
//  2, 2,    7
//  2, 3,    7
//  3, 2,    3, 3
//  3, 2,    6
//  3, 3,    7
//  4, 2,    3, 3
//  4, 2,    4, 4
//  4, 2,    6
//  4, 3,    6
//  4, 4,    3, 3
//  4, 4,    3, 4
//  4, 4,    4, 3
//  4, 4,    7
//  7,       7

// Line A is ({(2,2), (2,3), (3,2), (3,3), (4,2), (4,3), (4,4)}, {(4,2}, (3,3), (4,4), (3,4), (4,3), 6, 7})
// or (7, 7)

// a [2,3,4] must rhyme with a [2,3,4,6,7] or a [7] must rhyme with a [7]
// or a [2,3,4] must rhyme with an off [3,5]
// we'll call these rhymes A1 and A2
// we'll call unrhyming words X1 and X2
// for A1 if A1 is in [2,3,4] pluck X1 from [2,3,4] -- if A1 is in [7] X1 is nothing.
// for A2 if A2 is in [2,3,4,off3] pick X2 from [2,3,4]. if A2 in [off5,6,7] X2 is nothing.

  // And line B
  // 2, 2, 3, 2
  // 2, 2, 6
  // 2, 3, 6
  // 2, 4, 5
  // 2, 4, 7
  // 3, 2, 6
  // 3, 3, 1, 1, 3
  // 3, 3, 6
  // 3, 3, 7
  // 3, 4, 4
  // 4, 2, 7
  // 4, 3, 4, 3
  // 4, 3, 5
  // 4, 4, 5
  // 7,    7

  // Line B is ({2, 3, 4}, {2, 3, 4}, {(3, 2), (4, 3), (1, 1, 3), 4, 5, 6, 7}) or (7, 7)
// a [2,3,4] must rhyme with a [2,3,4,5,6,7] or a [7] must rhyme with a [7]

