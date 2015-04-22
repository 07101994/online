/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4; fill-column: 100 -*- */
/*
 * This file is part of the LibreOffice project.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#include <cassert>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>

#define LOK_USE_UNSTABLE_API
#include <LibreOfficeKit/LibreOfficeKit.h>
#include <LibreOfficeKit/LibreOfficeKitInit.h>

#include <png.h>

#include <Poco/Buffer.h>
#include <Poco/Process.h>
#include <Poco/Random.h>
#include <Poco/String.h>
#include <Poco/StringTokenizer.h>
#include <Poco/TemporaryFile.h>
#include <Poco/URI.h>
#include <Poco/Util/Application.h>

#include "LOKitHelper.hpp"
#include "Util.hpp"

using Poco::StringTokenizer;
using Poco::TemporaryFile;
using Poco::Util::Application;

class LOKitClient: public Application
{
public:
protected:
    int main(const std::vector<std::string>& args) override
    {
        if (args.size() != 2)
        {
            logger().fatal("Usage: lokitclient /path/to/lo/installation/program /path/to/document");
            return Application::EXIT_USAGE;
        }

        LibreOfficeKit *loKit;
        LibreOfficeKitDocument *loKitDocument;

        loKit = lok_init(args[0].c_str());
        if (!loKit)
        {
            logger().fatal("LibreOfficeKit initialisation failed");
            return Application::EXIT_UNAVAILABLE;
        }

        loKitDocument = loKit->pClass->documentLoad(loKit, args[1].c_str());
        if (!loKitDocument)
        {
            logger().fatal("Document loading failed: " + std::string(loKit->pClass->getError(loKit)));
            return Application::EXIT_UNAVAILABLE;
        }

        loKitDocument->pClass->initializeForRendering(loKitDocument);

        if (isatty(0))
        {
            std::cout << "Enter LOKit \"commands\", one per line. Enter EOF to finish." << std::endl;
        }

        while (!std::cin.eof())
        {
            std::string line;
            std::getline(std::cin, line);

            StringTokenizer tokens(line, " ", StringTokenizer::TOK_IGNORE_EMPTY | StringTokenizer::TOK_TRIM);

            if (tokens.count() == 0)
                continue;

            if (tokens[0] == "?" || tokens[0] == "help")
            {
                std::cout << 
                    "Commands mimic LOOL protocol but we talk directly to LOKit:" << std::endl <<
                    "    status" << std::endl <<
                    "        calls LibreOfficeKitDocument::getDocumentType, getParts, getPartName, getDocumentSize" << std::endl <<
                    "    tile pixelwidth pixelheight docposx docposy doctilewidth doctileheight" << std::endl <<
                    "        calls LibreOfficeKitDocument::paintTile" << std::endl;
            }
            else if (tokens[0] == "status")
            {
                if (tokens.count() != 1)
                {
                    std::cout << "? syntax" << std::endl;
                    continue;
                }
                std::cout << LOKitHelper::documentStatus(loKitDocument) << std::endl;
                for (int i = 0; i < loKitDocument->pClass->getParts(loKitDocument); i++)
                {
                    std::cout << "  " << i << ": '" << loKitDocument->pClass->getPartName(loKitDocument, i) << "'" << std::endl;
                }
            }
            else if (tokens[0] == "tile")
            {
                if (tokens.count() != 7)
                {
                    std::cout << "? syntax" << std::endl;
                    continue;
                }

                int canvasWidth(std::stoi(tokens[1]));
                int canvasHeight(std::stoi(tokens[2]));
                int tilePosX(std::stoi(tokens[3]));
                int tilePosY(std::stoi(tokens[4]));
                int tileWidth(std::stoi(tokens[5]));
                int tileHeight(std::stoi(tokens[6]));
                
                std::vector<unsigned char> pixmap(canvasWidth*canvasHeight*4);
                loKitDocument->pClass->paintTile(loKitDocument, pixmap.data(), canvasWidth, canvasHeight, tilePosX, tilePosY, tileWidth, tileHeight);

                if (!Util::windowingAvailable())
                    continue;

                std::vector<char> png;
                Util::encodePNGAndAppendToBuffer(pixmap.data(), canvasWidth, canvasHeight, png);

                TemporaryFile pngFile;
                std::ofstream pngStream(pngFile.path(), std::ios::binary);
                pngStream.write(png.data(), png.size());
                pngStream.close();
#ifdef __linux
                if (std::system((std::string("display ") + pngFile.path()).c_str()) == -1)
                {
                    // Not worth it to display a warning, this is just a throwaway test program, and
                    // the developer running it surely notices if nothing shows up...
                }
#endif
            }
            else
            {
                std::cout << "? unrecognized" << std::endl;
            }
        }

        return Application::EXIT_OK;
    }
};

POCO_APP_MAIN(LOKitClient)

/* vim:set shiftwidth=4 softtabstop=4 expandtab: */
