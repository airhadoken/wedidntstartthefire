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
    return n2w.toOrdinalWords(parseInt(match));
  })
  .replace(/[0-9]+/g, function(match) {
    return n2w.toWords(match);
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

    spec = spec.slice(0);
    var sublist = [];
    arr.forEach(function(arrayel) {
      var success = false;
      if(arrayel.used) {
        return false;
      }
      if(spec.length < 1)
        return false; // already done
      spec.forEach(function(specel, i) {
        if(success)
          return;
        if(Object.keys(specel).reduce(function(current, spkey) {
          if(typeof specel[spkey] === "function") {
            return current && specel[spkey](arrayel[spkey], arrayel, sublist);
          } else {
            return current && specel[spkey] === arrayel[spkey];
          }
        }, true)) {
          // spec matched.  Remove it and mark success
          spec.splice(i, 1);
          success = true;
        }
      });
      if(success) {
        sublist.push(arrayel);
      }
    });
    if(spec.length < 1) {
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
    words.forEach(indexword);
  };

  this.getAllRhymes = function(patterns) {
    try {
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
            console.log("trend retrieval success, resolving", that);
            deferred.resolve(that);
          } catch(e) {
            console.error(e.stack);
            //console.log("characters 0-10:", body.substr(0, 10));
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

    if(!wordslist.length) {
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
        upd_dfd = Q.nfcall(mongodb.updateMany(
          {_id: dirty.map(function(arg) { return arg._id; })},
          {$set : { used: true }}
        )).then(function() {
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
/*
var trends = {"trends":[{"name":"#Empire","query":"%23Empire","url":"http:\/\/twitter.com\/search?q=%23Empire","promoted_content":null},{"name":"#BB17","query":"%23BB17","url":"http:\/\/twitter.com\/search?q=%23BB17","promoted_content":null},{"name":"#CatHistory","query":"%23CatHistory","url":"http:\/\/twitter.com\/search?q=%23CatHistory","promoted_content":null},{"name":"#MTVFanWars5SOSFam","query":"%23MTVFanWars5SOSFam","url":"http:\/\/twitter.com\/search?q=%23MTVFanWars5SOSFam","promoted_content":null},{"name":"#blackish","query":"%23blackish","url":"http:\/\/twitter.com\/search?q=%23blackish","promoted_content":null},{"name":"Petey Pablo","query":"%22Petey+Pablo%22","url":"http:\/\/twitter.com\/search?q=%22Petey+Pablo%22","promoted_content":null},{"name":"Deray","query":"Deray","url":"http:\/\/twitter.com\/search?q=Deray","promoted_content":null},{"name":"Jason Richardson","query":"%22Jason+Richardson%22","url":"http:\/\/twitter.com\/search?q=%22Jason+Richardson%22","promoted_content":null},{"name":"Ride Along 2","query":"%22Ride+Along+2%22","url":"http:\/\/twitter.com\/search?q=%22Ride+Along+2%22","promoted_content":null},{"name":"Papelbon","query":"Papelbon","url":"http:\/\/twitter.com\/search?q=Papelbon","promoted_content":null}],"as_of":"2015-09-24T04:15:10Z","created_at":"2015-09-24T04:08:55Z","locations":[{"name":"United States","woeid":23424977}]}
trends = trends.trends;
trends = trends.map(function(trend) {
  var name = trend.name;
  name = name.replace(/#/g, "");
  name = name.replace(/([a-z0-9])(?=[A-Z])|([A-Z])(?=[A-Z][a-z])|([A-Za-z])(?=[0-9])/g, "$1$2$3#").split("#").join(" ");
  return name;
});
//console.log(trends);
trends.push("stupid shit", "nevermore", "9 eleven", "fuck the poor", "edward snowden", "bulldogs");
trends.push("larry wilmore", "trevor noah", "kim kardashian", "NSA", "tinder", "trans pacific partnership");
trends.push("2012 Benghazi attack","ABC Family","AR-MO Metropolitan Statistical Area","Aaron Rodgers","Abuja","Aceh","Activision","Adolescence","Adrian Peterson","Adrien Broner","Agilent Technologies","Aishwarya Rai Bachchan","Alfred Dunhill Links Championship","Alibaba Group","Amber Rose","American Apparel","American Hockey League","American Horror Story","American League","American League West","Andrew Luck","Android","Andy Roddick","Angela Merkel","Anthony Lozano","Apple Inc.","Arizona Diamondbacks","Arkansas","Arsenal F.C.","Arsène Wenger","Assassin's Creed","Assassins","Asthma","Aston Villa F.C.","Atlético Madrid","Australia","Auto show","BP","Bab-el-Mandeb","Baghdad","Baker Hughes","Baltimore Orioles","Banda Aceh","Barack Obama","Bayer 04 Leverkusen","Benton County","Berkeley","Bernd Leno","Beyoncé","Blackbeard","Blake Shelton","Blase J. Cupich","Boko Haram","Bologna F.C. 1909","Book","Boston Bruins","Boston Red Sox","Bound For Glory","Boxing","Brandon Mebane","Breast cancer","Brendan Gleeson","Brigham Young University","Brooklyn Decker","Buffalo","Buffalo Bills","Buffalo Sabres","Buffy Summers","Buffy the Vampire Slayer","Bureau of Alcohol","CNN","CONCACAF","CONCACAF Gold Cup","Cairo University","Caitlyn Jenner","California","California Department of Transportation","Cancer","Cannabis","Cargo planes bomb plot","Caron Butler","Carrie Mathison","Casino","Censorship","Chad Marshall","Charles Johnson","Charlotte Hornets","Chasing Life","Chevrolet Colorado","Chicago","Chicago Bears","Chicago Bulls","Chicago Cubs","China","Chris Bosh","Chris Davis","Cincinnati Reds","Clayton Kershaw","Cleveland Browns","Coachella Valley","College","Colorado Rapids","Colorado Rockies","Connecticut","Contract","Convention on the Rights of the Child","Crime","Cristiano Ronaldo","Daimler AG","Dako","Dallas Cowboys","Dallas Keuchel","Damon Lindelof","David Ferrer","David Texeira","Death","Deepwater Horizon oil spill","Demi Lovato","Denver Broncos","Derrick Rose","Des Plaines","Detroit Lions","Detroit Tigers","Dianna Duran","Don Orsillo","Donald Trump","Dover","Drake","Drew Brees","Driving","Dunkin' Donuts","East Asia","Eastern span replacement of the San Francisco–Oakland Bay Bridge","Economy","Education","Ellen DeGeneres","Ellen Page","Elon Musk","Emilie de Ravin","England","England national football team","Essex","FC Dallas","Fashion","Fayetteville-Springdale-Rogers","Federal Bureau of Investigation","Federal Reserve System","Feliciano López","Fiat Chrysler Automobiles","Fire","Fire Prevention Week","Firearms and Explosives","Food and Drug Administration","Ford Motor Company","France Ligue 1","François Hollande","Freeheld","French Riviera","Gambling","Games","General Mills","George H. W. Bush","George W. Bush","Georgia","Germany","Glencore Xstrata","Golden Tate","Golf","Google","Google Nexus","Gordon Hayward","Governor of California","Green Bay Packers","Green Zone","Guatemala","Guatemala City","Guillermo García-López","Haider al-Abadi","Harrisburg","Hector Balderas","Hernia","Hillary Rodham Clinton","Homeland","Honduras","Houston Astros","Houston Dynamo","Houthis","Hugh Jackman","Humble Bundle","Immigration","India","Indiana Fever","Indianapolis Colts","Indonesia","Injury","Intel","Inter Milan","Iraq","Islamic State of Iraq and the Levant","Italia Ricci","J. Whyatt Mondesire","Jack Dorsey","Jack Grealish","Jack Ma","Jacksonville Jaguars","Jake Arrieta","Jarius Wright","Jay Cutler","Jazbaa","Jeb Bush","Jennifer Aniston","Jeremy Affeldt","Jeremy Irons","Jerry Brown","Jihadism","Jimmy Fallon","Joachim Löw","Joaquín Guzmán","John Deere","Jonas Gustavsson","Jonesborough","Julianna Margulies","Julianne Moore","Just Kids","Justin Theroux","Juventus F.C.","Jürgen Klinsmann","Kanye West","Kapil Sharma","Kate Winslet","Keeping Up with the Kardashians","Kevin Faulconer","Kevin McCarthy","Khabib Allakhverdiev","Khloé Kardashian","Kim Kardashian","Kobe Bryant","Kourtney Kardashian","Kris Jenner","Kyrgyzstan","LA Galaxy","LG Corp","Lady Gaga","Laurel Hester","Leia Organa","Leonardo DiCaprio","Libya","Longs Peak","Los Angeles Angels of Anaheim","Los Angeles Dodgers","Los Angeles Lakers","Luke Mulholland","Lung cancer","Lyndon B. Johnson","Macau","Mahatma Gandhi","Malta","Manchester United F.C.","Marco Bueno","Mars","Marshawn Lynch","Massimiliano Allegri","McKeesport","Media","Mental Illness Awareness Week","Mental disorder","Mental health","Mercedes-Benz","Mercedes-Benz Actros","Merck & Co.","Mexico","Mexico national football team","Miami Dolphins","Miami Heat","Michael Fassbender","Microsoft Corporation","Miguel Cabrera","Miley Cyrus","Military","Milwaukee Brewers","Minnesota Lynx","Minnesota Vikings","Miranda Lambert","Mix Diskerud","Moldova","Monday Night Football","Montana","Morocco","NASCAR","NBA","NBA All-Star Game","NFL","NPR","NYSE","Nancy Pelosi","Narendra Modi","National Association for the Advancement of Colored People","National Hockey League","New Mexico","New Orleans","New Orleans Saints","New York Giants","New York Jets","New York Yankees","News","Nicholas Brendon","Nick Kyrgios","Nicotine","Nigeria","Nobel Prize","North Carolina","North Korea","Novak Djokovic","Nudity","OPEC","OVO Sound","Oakland Raiders","Obesity","Ohio","Olympiacos F.C.","Olympic Games","Olympique de Marseille","Omar Gonzalez","Once Upon a Time","Oregon","PAOK FC","PARTYNEXTDOOR","Painting","Palmyra","Pan","Paris","Paris Fashion Week","Paris Saint-Germain F.C.","Patreon","Patrick J. Kennedy","Patti Smith","Pennsylvania","Petroleum","Pharmaceutical drug","Philadelphia","Philadelphia Eagles","Pittsburgh Pirates","Porsche","Portugal","Rafael Nadal","Ralph Wilson","Real Madrid C.F.","Real Salt Lake","Red Sea","Regan Smith","Republican Party","Reserve Bank of India","Riyadh","Robert Mapplethorpe","Roberto Mancini","Robinson Canó","Rocky Mountain National Park","Roger Goodell","Roman Catholic Archdiocese of Chicago","Roseburg","Roy Hodgson","Russia","Ryan O'Reilly","Sam Smith","Samsung Galaxy","Samsung Galaxy Note series","Samsung Galaxy S6","San Diego","San Diego Chargers","San Diego Padres","San Francisco 49ers","San Francisco Giants","San Francisco–Oakland Bay Bridge","Santa Catarina Pinula","Saturday Night Live","Saudi Arabia","School","Scott Disick","Seattle Mariners","Seattle Seahawks","Seattle Sounders FC","Sebastian Janikowski","Serie A","Sharia","Sheldon Richardson","Shenzhen Open","Silicosis","Singapore","Siri","Skateboarding","SlutWalk","Snohomish","Somalia","South Africa","South Africa national cricket team","South China","South Dakota","South Korea","Spain","Sri Lanka","Star Wars","Star Wars Episode VI: Return of the Jedi","Star Wars: Battlefront","Starling Marte","Startup company","Steve Jobs","Stunted growth","Surgery","Susan G. Komen for the Cure","Syria","Tamika Catchings","Ted Kennedy","Tennessee","Tennessee Bureau of Investigation","Tennis","Texas Rangers","The Affair","The Church of Jesus Christ of Latter-day Saints","The Good Wife","The Great British Bake Off","The Leftovers","The Walking Dead","Thorbjørn Olesen","Tim Sherwood","Tobacco","Tomáš Berdych","Tony Hawk","Total Nonstop Action Wrestling","Toyota","Toyota Tacoma","Trans-Pacific Partnership","Troy Newman","Tunisia","Tuukka Rask","Twenty20","Twitter","U.C. Sampdoria","UEFA Euro 2016","Ukraine","Umpqua Community College","United Automobile Workers","United Nations","United States Congress","United States House of Representatives","United States men's national soccer team","United States of America","University of California","Utah Jazz","Violence","Vladimir Putin","Volkswagen Passenger Cars","WNBA Finals","Washington","Washington Redskins","Weight loss","West Hartford","West Virginia","Will Tye","William Shakespeare","Wiz Khalifa","Women's National Basketball Association","World Bank","Wynn Las Vegas","Wynn Resorts","Xfinity Series","Yemen","Youth","Zlatan Ibrahimović");
*/
var db = new worddb();
db.loadFromMongo().then(function(db) {
  return db.getNewTrends();
}).then(function(db) {
  var arhymes = zip(
    db.nonEmptyBuckets(["2", "3", "4"]), 
    db.nonEmptyBuckets(["2", "3", "4", "6", "7", "off3", "off4", "off6"]));
  var _word, aline, alinestr, bline, blinestr;

  if(db.nonEmptyBuckets(["7"]).length) {
    arhymes = arhymes.concat([["7", "7"]]);
  }
  var rhyme_candidates = db.getAllRhymes(arhymes);

  var keys = Object.keys(rhyme_candidates).sort(function(a, b) {
    return a.length === b.length ? 0 : (a.length < b.length ? 1 : -1);
  });

  aline = rhyme_candidates[keys.shift()].pluck();
  if(!aline) {
    return Q.reject({stack: "No rhyme was found for A-pattern"});
  }
  db.markused.apply(db, aline.result);

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


  bline = rhyme_candidates[keys.shift()].pluck();
  if(!aline) {
    return Q.reject({stack: "No rhyme was found for A-pattern"});
  }
  db.markused.apply(db, bline.result);

  if(~["2", "3", "4", "off3", "off6"].indexOf(bline.key[1])) {
    bline.result.splice(1, 0, db.getWord(db.nonEmptyBuckets(["2", "3", "4"]).pluck()));
  } 
  if(~["2", "3", "4"].indexOf(bline.key[0])) {
    bline.result.unshift(db.getWord(db.nonEmptyBuckets(["1", "2", "3", "4"]).pluck()));
    if(bline.result[0].syllcount === 1) {
      bline.result.unshift(db.getWord("1"));
    }
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

  return Q.all([
    Q.nfcall(T.post.bind(T), 'statuses/update', { status: alinestr + "\n" + blinestr }).then(function(reply) {
      console.log("reply: " + reply);    
    }),
    db.saveToMongo()
  ]);
}).then(function() {
  console.log("save success.  finish process");
}, function(e) {
  console.error(e.stack);
});
return;


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

function weighted_random() {
  var args = Array.prototype.slice.call(arguments, 0),
  weights = args.filter(function(arg, i) {
    return i % 2;
  }),
  measures = args.filter(function(arg, i) {
    return i % 2 - 1;
  }),
  total_weight = weights.reduce(function(a, b) { return a + b; }, 0),
  candidate = Math.floor(Math.random() * total_weight);

  while(candidate >= weights[0]) {
    candidate -= weights.shift();
    measures.shift();
  }
  return measures[0];
}

// Line A is ({(2,2), (2,3), (3,2), (3,3), (4,2), (4,3), (4,4)}, {(4,2}, (3,3), (4,4), (3,4), (4,3), 6, 7})
// or (7, 7)

// a [2,3,4] must rhyme with a [2,3,4,6,7] or a [7] must rhyme with a [7]
// or a [2,3,4] must rhyme with an off [3,5]
// we'll call these rhymes A1 and A2
// we'll call unrhyming words X1 and X2
// for A1 if A1 is in [2,3,4] pluck X1 from [2,3,4] -- if A1 is in [7] X1 is nothing.
// for A2 if A2 is in [2,3,4,off3] pick X2 from [2,3,4]. if A2 in [off5,6,7] X2 is nothing.
function zip(arr, brr) {
  return [].concat.apply([], arr.map(function(a) {
    return brr.map(function(b) {
      return [a, b];
    });
  }));
}

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

