var MineSweeper = require('./mine').MineSweeper;

module.exports = function(app) {
    var io = require("socket.io").listen(app);
    
    if(process.env.VCAP_APP_PORT) {
    io.set('transports', [
        'websocket',
        'flashsocket',
        'htmlfile',
        'xhr-polling',
        'jsonp-polling'
    ]);
    }


    var games = {};

    var RedisGameClient = require("./redis-game-client");
    var gameClient = new RedisGameClient();

    function assignPlayerToGame(player, game, rejoin, socket) {
        socket.join(game.gameId);

        socket.emit("game-assignment", {
            "gameId": game.gameId,
            "players": game.players,
            "player": player,
            "board": game.board.state(),
            "active": game.board.started ? 'active': 'inactive',
            "multiplier": game.board.multiplier
        });

        var event = (rejoin ? "player-rejoined": "new-player");

        socket.broadcast.to(game.gameId).emit(event, {
            "gameId": game.gameId,
            "players": game.players,
            "board": game.board.state(),
            "player": player,
            "active": game.board.started ? 'active': 'inactive',
            "multiplier": game.board.multiplier
        });
    }

    io.sockets.on("connection", function(socket) {
        socket.on("disconnect", function() {
            console.log("Received socket disconnect, args: %j", Array.prototype.slice.call(arguments));
        });

        socket.on("join", function(playerData) {
            gameClient.getAvailableGame(function(err, game) {
                gameClient.addPlayerToGame(game, playerData.playerName, function(err, data) {
                    if (err) {
                        if (err.error === "NAME_IN_USE") {
                            return socket.emit("name-in-use", playerData.playerName);
                        }
                    }

                    assignPlayerToGame(data.player, data.game, false, socket);
                });
            });
        });

        socket.on("rejoin", function(data) {
            gameClient.getGame(data.gameId, function(err, game) {
                if (err) {
                    return socket.emit("rejoin-failed", "error");
                }

                if (game.board.over()) {
                    return socket.emit("rejoin-failed", "game-over");
                } else {
                    gameClient.reactivatePlayerInGame(data.playerName, game, function(err, data) {
                        assignPlayerToGame(data.player, data.game, true, socket);
                    });
                }
            });
        });

        socket.on("leave", function(data) {
            gameClient.getGame(data.gameId, function(err, game) {
                if (err) {
                    return socket.emit("left-game", "error");
                }

                gameClient.removePlayerFromGame(data.playerName, game, function(err, data) {
                    console.log("Player removed from game? err: %j, data: %j", err, data);
                    if (err) {
                        return socket.emit("left-game", "error");
                    }

                    socket.broadcast.to(data.game.gameId).emit("player-left", {
                        "gameId": data.game.gameId,
                        "players": data.game.players,
                        "board": data.game.board.state(),
                        "player": data.player,
                        "active": data.game.board.started ? 'active': 'inactive',
                        "multiplier": data.game.board.multiplier
                    });

                    return socket.emit("left-game");
                });
            });
        });

        socket.on("chat", function(data) {
            gameClient.getGame(data.game, function(err, game) {
                if (err) {
                    return;
                }
                socket.emit("chat", data);
                socket.broadcast.to(game.gameId).emit("chat", data);
            });
        });

        socket.on("start", function beginGame(data) {
            gameClient.getGame(data.game, function(err, game) {
                if (err) {
                    return;
                }
                game.board.startGame();
                gameClient.updateGame(game, function(err, updatedGame) {
                    console.log("broadcasting new game start");

                    data.board = updatedGame.board.state();
                    data.players = updatedGame.players;

                    socket.emit("game-start", data);
                    socket.broadcast.to(game.gameId).emit("game-start", data);
                });
            });
        });

        socket.on("flag", function handleTurn(data) {
            gameClient.getGame(data.game, function(err, game) {
                if (err) {
                    return;
                }
                if (!game.board.started) {
                    return;
                }
                game.board.toggleFlag(data.x, data.y);
                gameClient.updateGame(game, function(err, updatedGame) {
                    console.log("broadcasting new game state");

                    data.board = updatedGame.board.state();
                    data.players = updatedGame.players;
                    data.active = updatedGame.board.started ? 'active': 'inactive'
                    data.multiplier = updatedGame.board.multiplier

                    socket.emit("move-made", data);
                    socket.broadcast.to(game.gameId).emit("move-made", data);

                    if (game.board.over(game)) {
                        gameClient.endGame(game, function(err) {
                            socket.emit("end-game", data);
                            socket.broadcast.to(game.gameId).emit("end-game", data);
                            gameClient.postScores(game.players, function(err) {
                                if (err) {
                                    console.log("Error:" + err);
                                }
                            });
                            return;
                        });
                    }
                });
            });
        });

        socket.on("turn", function handleTurn(data) {
            gameClient.getGame(data.game, function(err, game) {
                if (err) {
                    return;
                }
                if (!game.board.started) {
                    return;
                }
                var points = game.board.revealed;
                var outcome = game.board.revealTile(data.x, data.y, true);
                points = game.board.revealed - points;
                adjustScore(game.players, data.playerName, points, game.board.multiplier);
                data.players = game.players;
                console.log("Points: %s", points);
                console.log("Adjust multi = %d", game.board.multiplier);
                if (!outcome) {
                    gameClient.stat("total_bombs");
                    adjustScore(game.players, data.playerName, MineSweeper.BOMB_PENALTY, game.board.multiplier);
                    data.players = game.players;
                    socket.emit("mine-hit", data);
                    socket.broadcast.to(game.gameId).emit("mine-hit", data);
                    console.log("Hit a mine at %s,%s", data.x, data.y);
                }
                var multi = Math.ceil((game.board.revealed * 10) / (game.board.width * game.board.height));
                console.log("percent %d", multi);
                game.board.multiplier = multi;
                data.multiplier = multi;

                gameClient.updateGame(game, function(err, updatedGame) {
                    console.log("broadcasting new game state");

                    data.board = updatedGame.board.state();
                    data.active = updatedGame.board.started ? 'active': 'inactive'
                    socket.emit("move-made", data);
                    socket.broadcast.to(game.gameId).emit("move-made", data);

                    if (game.board.over(game)) {
                        gameClient.endGame(game, function(err) {
                            socket.emit("end-game", data);
                            socket.broadcast.to(game.gameId).emit("end-game", data);
                            gameClient.postScores(game.players, function(err) {
                                if (err) {
                                    console.log("Error:" + err);
                                }
                            });
                            return;
                        });
                    }
                });
            });
        });

        function adjustScore(players, player, amount, multiplier) {
            for (var i = 0; i < players.length; i++) {
                if (players[i].playerName === player) {
                    console.log("Adjusting %s score: %d, by %d", player, players[i].score, amount);
                    players[i].score += (amount * multiplier);
                }
            }
        }
    });
};
