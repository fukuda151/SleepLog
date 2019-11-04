'use strict';
var Alexa = require('alexa-sdk');
var AWS = require('aws-sdk');
var moment = require('moment-timezone');
moment.tz.setDefault("Asia/Tokyo");

exports.handler = function(event, context, callback) {
    var alexa = Alexa.handler(event, context);
    alexa.dynamoDBTableName = 'SleepTable';
    alexa.appId = process.env.ALEXA_APPLICATION_ID;
    alexa.registerHandlers(handlers, idealtimeHandlers, offsetHandlers);
    alexa.execute();
};

var handlers = {
    //インテント無しでスキルを起動した場合。
    'LaunchRequest': function () {
        var message = '睡眠ログを起動しました。どうしますか？';
        var reprompt = '使い方を知りたい場合は「ヘルプ」と言って下さい';
        this.emit(':ask', message, reprompt);
    },
    //就寝時間記録インテント
    'SleepIntent': function () {
        //numは睡眠ログの個数。就寝時間記録時にインクリメント。
        var num;
        if (this.attributes['num']){
            num = this.attributes['num'] + 1;
        } else {
            num = 1;
        }
        this.attributes['num'] = num;
        
        //dynamoDBでの配列の書き方が分からんからb1,b2‥に就寝時間を記録。
        var now = moment();
        this.attributes['b' + num] = now.valueOf();

        //睡眠時間を仮で0に設定。起床時間記録時に上書き。
        this.attributes['s' + num] = 0;

        //音声出力。emit時にattributesがdynamoDBに保存される。
        var message = 'おやすみなさい。';
        this.emit(':tell', message);
    },
    //起床時間記録インテント
    'WakeupIntent': function () {
        var now = moment();
        var num;
        if (this.attributes['num']){
            num = this.attributes['num'];
        } else {
            //就寝時間が存在しない場合は新規の0時間の睡眠として記録。
            num = 1;
            this.attributes['num'] = num;
            this.attributes['b' + num] = now.valueOf();
            this.attributes['s' + num] = 0;
        }
        //既に睡眠時間が記録されている場合（起床時間記録を連続で呼び出した場合）は新規の0時間の睡眠として記録。
        if (this.attributes['s' + num] != 0){
            num = num + 1;
            this.attributes['num'] = num;
            this.attributes['b' + num] = now.valueOf();
            this.attributes['s' + num] = 0;
        }
        
        //直近の就寝時間からの差分を睡眠時間としてs1,s2‥に記録する。
        var lastbedtime = this.attributes['b' + num];
        this.attributes['s' + num] = now.diff(moment(lastbedtime), 'seconds');

        //睡眠負債計算用の累計睡眠時間に加算する。
        if (!this.attributes['sum']){
            this.attributes['sum'] = 0;
        }
        this.attributes['sum'] = this.attributes['sum'] + now.diff(moment(lastbedtime), 'seconds');

        //睡眠時間を音声出力。
        var sleeptimehh = now.diff(moment(lastbedtime), 'hours');
        var sleeptimemm = now.diff(moment(lastbedtime), 'minutes') % 60;
        var message = 'おはようございます。睡眠時間は';
        if (sleeptimehh == 0){
            message = message + sleeptimemm + '分です。';
        } else if(sleeptimemm == 0){
            message = message + sleeptimehh + '時間です。';
        } else {
            message = message + sleeptimehh + '時間' + sleeptimemm + '分です。';
        }
        this.emit(':tell', message);
    },
    //平均睡眠時間インテント
    'AverageIntent': function () {
        var num;
        var message;
        if (this.attributes['num']){
            num = this.attributes['num'];
        } else {
            message = '睡眠ログが存在しないため、平均睡眠時間を計算できません。スキルを終了します。';
            this.emit(':tell', message);
        }
        //平均期間の指定をチェック。デフォルトは直近一週間。
        var span = this.event.request.intent.slots.Duration.value;
        var spandays = 7;
        if (span != undefined) {
            spandays = moment.duration(span).asDays();
        }

        //var spanid = 'week';
        //if (span.resolutions != undefined) {
        //    if (span.resolutions.resolutionsPerAuthority[0].status.code == 'ER_SUCCESS_MATCH') {
        //        spanid = span.resolutions.resolutionsPerAuthority[0].values[0].value.id;
        //    }
        //}

        message = '直近' + spandays + '日間の平均睡眠時間は';

        //期間内の合計睡眠時間を計算
        var now = moment();
        var start = now.subtract(spandays, 'days').valueOf();
        var sum = 0;
        for (var i = num; i > 0;  i--) {
            if (start < this.attributes['b' + i]){
                if (this.attributes['s' + i]){
                    sum = sum + this.attributes['s' + i];
                }
            } else{
                break;
            }
        }

        //平均睡眠時間を計算して音声出力。
        sum = Math.floor(sum / spandays);
        var averagetimehh = Math.floor(sum / 3600);
        var averagetimemm = Math.floor(sum / 60 % 60);
        if (averagetimehh == 0){
            message = message + averagetimemm + '分です。';
        } else if(averagetimemm == 0){
            message = message + averagetimehh + '時間です。';
        } else {
            message = message + averagetimehh + '時間';
            message = message + averagetimemm + '分です。';
        }
        this.emit(':tell', message);
    },
    //睡眠負債インテント
    'DebtIntent': function () {
        var message;
        if (!this.attributes['num']){
            message = '睡眠ログが存在しないため、睡眠負債を計算できません。スキルを終了します。';
            this.emit(':tell', message);
        }

        var now = moment();
        var spandays = now.diff(moment(this.attributes['b1']), 'days');

        //目標睡眠時間が設定されていない場合はデフォルトの8時間に設定。
        if (!this.attributes['idealtime']){
            this.attributes['idealtime'] = 8 * 3600;
        }

        //累計睡眠時間が存在しない場合は0時間に設定。
        if (!this.attributes['sum']){
            this.attributes['sum'] = 0;
        }

        //オフセットが設定されていない場合はデフォルトの0時間に設定。
        if (!this.attributes['offset']){
            this.attributes['offset'] = 0;
        }

        //目標睡眠時間と累計睡眠時間の差分を計算。
        var debt = this.attributes['idealtime'] * spandays - this.attributes['sum'] - this.attributes['offset'];

        //結果を音声出力。
        var idealtimehh = Math.floor(this.attributes['idealtime'] / 3600);
        var idealtimemm = Math.floor(this.attributes['idealtime'] / 60 % 60);
        message = '目標睡眠時間を';
        if (idealtimemm == 0){
            message = message + idealtimehh + '時間、';
        } else{
            message = message + idealtimehh + '時間';
            message = message + idealtimemm + '分、';
        }
        var minusflag = "";
        if (this.attributes['offset'] < 0){
            minusflag = "マイナス";
        }
        var offsethh = Math.floor(Math.abs(this.attributes['offset']) / 3600);
        var offsetmm = Math.floor(Math.abs(this.attributes['offset']) / 60 % 60);
        message = message + "オフセットを" + minusflag;
        if (offsethh == 0){
            message = message + offsetmm + '分として、';
        } else if(offsetmm == 0){
            message = message + offsethh + '時間として、';
        } else {
            message = message + offsethh + '時間';
            message = message + offsetmm + '分として、';
        }
        message = message + moment(this.attributes['b1']).year() + "年";
        message = message + (moment(this.attributes['b1']).month() + 1) + "月";
        message = message + moment(this.attributes['b1']).date() + "日からの";
        if (debt <= 0){
            message = message + '睡眠負債はありません。';
        } else{
            var debthh = Math.floor(debt / 3600);
            var debtmm = Math.floor(debt / 60 % 60);
            message = message + '睡眠負債は';
            if (debthh == 0){
                message = message + debtmm + '分です。';
            } else if(debtmm == 0){
                message = message + debthh + '時間です。';
            } else {
                message = message + debthh + '時間';
                message = message + debtmm + '分です。';
            }
        }
        this.emit(':tell', message);
    },
    //目標睡眠時間インテント
    'IdealTimeIntent': function() {
        
        //目標睡眠時間が設定されていない場合はデフォルトの8時間を設定。
        if (!this.attributes['idealtime']){
            this.attributes['idealtime'] = 8 * 3600;
        }

        var idealtime = this.event.request.intent.slots.Duration.value;
        if (idealtime != undefined) {
            //目標睡眠時間の指定があった場合はそのまま設定。
            setidealtime(this, idealtime);
        } else{
            //目標睡眠時間の設定モードに移行。
            this.handler.state = '_IDEALTIMEMODE';
            var message = '目標睡眠時間は睡眠負債の計算に利用します。';
            var idealtimehh = Math.floor(this.attributes['idealtime'] / 3600);
            var idealtimemm = Math.floor(this.attributes['idealtime'] / 60 % 60);
            message = message + '現在の目標睡眠時間は';
            if (idealtimemm == 0){
                message = message + idealtimehh + '時間です。';
            } else{
                message = message + idealtimehh + '時間';
                message = message + idealtimemm + '分です。';
            }
            message = message + '新しい目標睡眠時間を教えて下さい。';
            this.emit(':ask', message);
        }
    },
    //オフセットインテント
    'OffsetIntent': function () {
        if (!this.attributes['offset']){
            this.attributes['offset'] = 0;
        }

        var offsetdiff = this.event.request.intent.slots.Duration.value;
        var zougen = this.event.request.intent.slots.Zougen.resolutions;

        var message;
        if (offsetdiff != undefined) {
            setoffset(this, offsetdiff, zougen);
        } else{
            this.handler.state = '_OFFSETMODE';
            message = 'オフセットは睡眠負債の計算時に累計睡眠時間に加算されます。';
            message = message + '睡眠ログに正しく睡眠時間を記録できなかった場合、オフセットを増加または減少して調整して下さい。';
            var minusflag = "";
            if(this.attributes['offset'] < 0){
                minusflag = "マイナス";
            }
            var offsethh = Math.floor(Math.abs(this.attributes['offset']) / 3600);
            var offsetmm = Math.floor(Math.abs(this.attributes['offset']) / 60 % 60);
            message = message + "現在のオフセットは" + minusflag;
            if (offsethh == 0){
                message = message + offsetmm + '分です。';
            } else if(offsetmm == 0){
                message = message + offsethh + '時間です。';
            } else {
                message = message + offsethh + '時間';
                message = message + offsetmm + '分です。';
            }
            message = message + 'オフセットの増減を教えて下さい。';
            this.emit(':ask', message);
        }
    },
    'AMAZON.HelpIntent': function () {
        var message = "睡眠ログは毎日の睡眠時間を記録するスキルです。";
        message = message + "就寝時間を記録する場合は「おやすみ」、";
        message = message + "起床時間を記録する場合は「おはよう」と言って下さい。";
        message = message + "平均睡眠時間を知りたい場合は、「平均睡眠時間」と言って下さい。";
        message = message + "睡眠負債を知りたい場合は、「睡眠負債」と言って下さい。";
        message = message + "目標睡眠時間を設定する場合は、「目標睡眠時間」と言って下さい。";
        message = message + "オフセットを設定する場合は、「オフセット」と言って下さい。";
        var reprompt = "どうしますか？";

        this.emit(':ask', message, reprompt);
    },
    'AMAZON.CancelIntent': function () {
        this.emit(':tell', "スキルを終了します。");
    },
    'AMAZON.StopIntent': function () {
        this.emit(':tell', "スキルを終了します。");
    },
    'Unhandled': function() {
        this.handler.state = '';
        this.attributes['STATE'] = undefined;
        var message = 'すみません。聞き取れなかったのでもう一度言って下さい。';
        var reprompt = 'もう一度言って下さい。';
        this.emit(':ask', message, reprompt);
    }
};
//目標睡眠時間設定モード
var idealtimeHandlers = Alexa.CreateStateHandler('_IDEALTIMEMODE', {
    'DurationIntent': function() {
        //ハンドラの実行後、スキルの初期状態に戻すためステートをリセット。
        this.handler.state = '';
        this.attributes['STATE'] = undefined;
        var idealtime = this.event.request.intent.slots.Duration.value;
        setidealtime(this, idealtime);
    },
    'Unhandled': function() {
        this.handler.state = '';
        this.attributes['STATE'] = undefined;
        var message = 'すみません。聞き取れなかったのでスキルを終了します。';
        this.emit(':tell', message);
    }
});
//オフセット設定モード
var offsetHandlers = Alexa.CreateStateHandler('_OFFSETMODE', {
    'ZougenIntent': function() {
        this.handler.state = '';
        this.attributes['STATE'] = undefined;
        var offsetdiff = this.event.request.intent.slots.Duration.value;
        var zougen = this.event.request.intent.slots.Zougen.resolutions;
        setoffset(this, offsetdiff, zougen);
    },
    'Unhandled': function() {
        this.handler.state = '';
        this.attributes['STATE'] = undefined;
        var message = 'すみません。聞き取れなかったのでスキルを終了します。';
        this.emit(':tell', message);
    }
});

function setidealtime(that, idealtime){
    var message;
    that.attributes['idealtime'] = moment.duration(idealtime).asSeconds();
    var idealtimehh = Math.floor(that.attributes['idealtime'] / 3600);
    var idealtimemm = Math.floor(that.attributes['idealtime'] / 60 % 60);
    message = '目標睡眠時間を';
    if (idealtimemm == 0){
        message = message + idealtimehh + '時間';
    } else{
        message = message + idealtimehh + '時間';
        message = message + idealtimemm + '分';
    }
    message = message + 'に設定しました。';
    that.emit(':tell', message);
}

function setoffset(that, offsetdiff, zougen){
    var zougenid = 'plus';
    if (zougen != undefined) {
        if (zougen.resolutionsPerAuthority[0].status.code == 'ER_SUCCESS_MATCH') {
            zougenid = zougen.resolutionsPerAuthority[0].values[0].value.id;
        }
    }
    var offsetdiffss = moment.duration(offsetdiff).asSeconds();
    var offsetdiffhh = Math.floor(offsetdiffss / 3600);
    var offsetdiffmm = Math.floor(offsetdiffss / 60 % 60);
    
    var message = "オフセットを";
    if (offsetdiffhh == 0){
        message = message + offsetdiffmm + '分';
    } else if(offsetdiffmm == 0){
        message = message + offsetdiffhh + '時間';
    } else {
        message = message + offsetdiffhh + '時間';
        message = message + offsetdiffmm + '分';
    }
    if (zougenid == 'minus'){
        that.attributes['offset'] = that.attributes['offset'] - offsetdiffss;
        message = message + "減らしました。";
    } else {
        that.attributes['offset'] = that.attributes['offset'] + offsetdiffss;
        message = message + "増やしました。";
    }
    var minusflag = "";
    if(that.attributes['offset'] < 0){
        minusflag = "マイナス";
    }
    var offsethh = Math.floor(Math.abs(that.attributes['offset']) / 3600);
    var offsetmm = Math.floor(Math.abs(that.attributes['offset']) / 60 % 60);
    message = message + "変更後のオフセットは" + minusflag;
    if (offsethh == 0){
        message = message + offsetmm + '分です。';
    } else if(offsetmm == 0){
        message = message + offsethh + '時間です。';
    } else {
        message = message + offsethh + '時間';
        message = message + offsetmm + '分です。';
    }
    that.emit(':tell', message);
}