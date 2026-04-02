FROM eclipse-temurin:11-jre-alpine

WORKDIR /opt/ibkr

# Copy the Client Portal Gateway files (from the official IB zip)
COPY gateway/bin/ ./bin/
COPY gateway/build/ ./build/
COPY gateway/dist/ ./dist/
COPY gateway/root/ ./root/

# Overwrite default conf.yaml with our Docker-friendly config
COPY conf.yaml ./root/conf.yaml

# Make run script executable
RUN chmod +x bin/run.sh

EXPOSE 5000

# Start the gateway with our config
CMD ["bin/run.sh", "root/conf.yaml"]
